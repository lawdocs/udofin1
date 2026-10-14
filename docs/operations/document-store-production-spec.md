# Production document store: requirements for the S3 and KMS adapter

|              |                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | **Specification only. No code, no dependency, no AWS resource exists.** Staging and production answer `503` on every document route until this is built and approved.                                               |
| Decision     | ADR 0010 (Proposed) decisions 3 and 4: S3 in ap-south-1 with SSE-KMS, Block Public Access, Object Lock for audit and log archives; not Supabase Storage. ADR 0009 item 5 (per-lender envelope encryption, planned). |
| Origin       | Architecture verification, `docs/architecture/phase-02-architecture-verification.md`, register item K and the conformance row "Document store in India with KMS: Not implemented (P1, blocks production)".          |
| Not in scope | KYC artefacts, bureau reports and Account Aggregator data. ADR 0009 says no lender-owned sensitive data may be stored until per-lender envelope encryption exists. This store alone is **not** enough for those.    |

## 1. What exists and what does not

| Item                                                                                                                          | State                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentStore` port: `put(key, bytes, {mimeType, sha256})`, `get(key)`, `delete(key)` (`packages/adapters/src/documents.ts`) | Exists. Keys are opaque, validated by `assertValidDocumentKey` (`^[A-Za-z0-9/_-]{8,200}$`, no `..`, no leading or doubled `/`).                   |
| Local filesystem store                                                                                                        | Exists; unencrypted; refused outside `local` and `test`.                                                                                          |
| `createObjectStorageDocumentStore(client, {bucket, kmsKeyId})` and the `ObjectStorageClient` interface                        | Exist as a thin wrapper that always passes a KMS key and checks the SHA-256 before writing; covered by `documents.test.ts` with a fake client.    |
| A real `ObjectStorageClient` over the AWS SDK                                                                                 | **Does not exist.** No AWS SDK dependency is in the repository.                                                                                   |
| Wiring in `services/api/src/server.ts`                                                                                        | Only the local store is wired. There is no configuration for a bucket or key.                                                                     |
| Hash checks                                                                                                                   | The API stores the SHA-256 in the database and recomputes it on every read, refusing a mismatch (`services/api/src/modules/documents/routes.ts`). |
| Access evidence                                                                                                               | Every retrieval is authorised by a database call and recorded (`documents.access_log`).                                                           |
| Retention                                                                                                                     | Undefined. Documents carry `retention_class = 'pending_d25'` (decision D-25 open). Nothing deletes a stored document automatically.               |
| Malware scanning, per-lender quota                                                                                            | None (audit R-06).                                                                                                                                |

Who writes: the API (lender onboarding evidence, uploaded KFS files) and the worker (generated KFS and agreement PDFs). Both call `store.put`,
and on a database failure after the write both call `store.delete` to avoid an orphan (`onboarding/routes.ts`, `documents/routes.ts`, `workers/documents-handlers.ts`).

## 2. Requirements

Each requirement is something a reviewer can check against the infrastructure code or a test. **Must** is required before any real document is stored.

### 2.1 Location and accounts

1. **Must** use buckets in `ap-south-1` only. A configuration refuses any other region, and the infrastructure code carries a region allowlist
   (`ap-south-1`, later `ap-south-2` for disaster recovery) as ADR 0010 requires. Nothing outside India stores or caches a document.
2. **Must** use separate buckets, keys and roles for each environment. Production lives in the production AWS account. Any staging bucket is in a
   non-production account and holds synthetic documents only (`CLAUDE.md` rule 7).
3. Bucket names are neutral and contain no tenant, lender or personal data.

### 2.2 Encryption

4. **Must** use server-side encryption with a customer-managed KMS key (SSE-KMS). SSE-S3 is not acceptable. The bucket policy **denies** `PutObject`
   that lacks `x-amz-server-side-encryption: aws:kms` or names a different key. Default bucket encryption is set to the same key.
5. **Must** use one KMS key per environment as the minimum ("key per environment"): a staging key can never decrypt production data. Automatic key rotation on.
   The key policy allows the API and worker roles to use the key only through S3 (`kms:ViaService`), allows no human to use the key for decrypt in normal
   operation, separates key administrators from key users, and sets the deletion window to the maximum (30 days).
6. **Target, owner and counsel decision (D-47):** one KMS key **per lender**, with a lender-controlled key policy. The ADR 0010 amendment records that for cloud services
   the Outsourcing Directions require encryption keys to be under the regulated entity's control (para 97(vii)(b) as quoted there; verify against the primary text),
   so a single key held by Udofin is likely a blocker for lenders. The existing `ObjectStorageClient.putObject` already takes a `kmsKeyId` per call; the wrapper
   `createObjectStorageDocumentStore` takes one key for the whole store and would need a per-lender resolver. Do not store a bank's or an NBFC's documents under one shared key
   without that decision.
7. S3 Bucket Keys may be used to reduce KMS calls. If per-lender keys are adopted, check how Bucket Keys change the encryption context before relying on a per-object key condition.

### 2.3 No public access, no unmanaged access

8. **Must** have S3 Block Public Access on all four settings at account and bucket level, ACLs disabled (`BucketOwnerEnforced`), no website hosting, no CORS configuration.
9. **Must** have a bucket policy that denies requests without TLS (`aws:SecureTransport`), denies any principal except the API role, the worker role and a named break-glass role, and,
   if a VPC gateway endpoint is used, requires that endpoint (`aws:SourceVpce`).
10. **No presigned URLs by default.** Today the API reads the bytes after the database authorisation call and streams them back. That keeps the hash re-check and the access record on
    every retrieval, which a presigned URL would bypass. ADR 0010 decision 4 speaks of "short-lived presigned URLs": streaming through the API is stricter, so this spec keeps it.
    **Decision to confirm:** if presigned URLs are ever wanted (large files), they need a very short lifetime, no CDN in the path, and a separate record of issuance; none is designed here.
11. Separate IAM roles for the API and the worker with least privilege on the document prefix only: `s3:PutObject` and `s3:GetObject`, plus the KMS permissions in item 5.
    `s3:DeleteObject` is needed today because both write paths delete a just-written object when the database insert fails. Either grant delete to those roles with versioning on
    (a delete leaves a recoverable version, and CloudTrail alerts on delete), or move that clean-up to a worker sweeper. Decision for the implementer to bring to the owner.
    `s3:DeleteObjectVersion` is held only by the retention role (item 18).

### 2.4 Integrity and write-once behaviour

12. **Must** send the SHA-256 the API already computed as the S3 additional checksum (`ChecksumSHA256`, base64 of the digest; the port carries it as hex, so the adapter converts) so that S3 rejects a corrupted upload.
    Do not use the ETag as an integrity check.
13. **Must** refuse to overwrite: use a conditional write (`If-None-Match: *`) so an existing key is never replaced, matching the local store's exclusive-create behaviour.
    Enable bucket versioning as a second layer.
14. On read, the API's existing SHA-256 re-check stays and is the authority. The adapter returns the bytes and the content type it stored; it never infers a type from the key.
15. A scheduled integrity scrub (a worker job re-hashing a sample of objects against the database) is recommended. Not required for the first release; list it in the risk register if skipped.

### 2.5 Archives and Object Lock

16. Audit-anchor exports and log archives go to a **separate** bucket with versioning and **Object Lock** (compliance mode, retention period set by the owner). The audit anchoring job
    (ADR 0013) does not exist yet. Object Lock is **not** enabled on the document bucket by default: a compliance-mode lock would stop us deleting a borrower's or lender's documents when
    law or a retention rule requires it. Whether any document class needs a lock is part of D-25.

### 2.6 Retention, deletion and legal hold (pending D-25)

17. Until D-25 is decided no automatic deletion exists and no lifecycle rule expires current objects. Documents are kept and `retention_class` stays `pending_d25`.
18. The deletion hooks to design **now** so D-25 can be implemented without a rewrite:
    - the database decides what is due for deletion (a retention class with a period, a legal-hold flag, lender exit) and records the decision and the reason in the audit trail;
    - a retention job in the worker is the only caller of delete for due objects: it removes the object **and** its versions (`DeleteObjectVersion`), then records `storage_deleted_at` and an audit event;
    - the only deletion primitive is `DocumentStore.delete(key)`; it must be idempotent and succeed on a missing key;
    - a lifecycle rule may expire **non-current versions** after a short period and abort incomplete multipart uploads, because versioning would otherwise keep deleted data;
    - if per-lender keys exist, scheduling that key's deletion is a second, stronger erasure step (crypto-shredding, ADR 0009), taken only on lender exit and with counsel's agreement.
19. Deletion of identity in the authentication provider is a separate pending item and is not solved here.

### 2.7 Failure behaviour

20. Calls are bounded (suggest 5 s connect and 30 s total) with a small number of retries for idempotent operations only. A timeout on `put` is **unknown**, not failure: confirm with a `HEAD` on the key and its checksum before
    the caller records or abandons the document.
21. Errors reaching the client are the existing `503 documents_unavailable` problem. Bucket names, key ids, ARNs and AWS error text never appear in responses or logs; only an error class and the request id.
22. The adapter's descriptor is `production` mode, so the environment guard (`assertProviderAllowed`) keeps mock and local stores out of deployed environments. A deployed API with no store configured keeps answering `503`; it never falls back to disk.

### 2.8 Configuration

23. Configuration is validated at start-up like every other setting (`services/api/src/config.ts`): bucket name, KMS key id and region are required together when the S3 store is selected, the region must be `ap-south-1`,
    and messages name variables, not values. Credentials come from the task or instance role; **no access keys in environment files**. Placeholders only in `*.env.example`.

### 2.9 Monitoring and audit

24. CloudTrail data events for the bucket and KMS key usage events go to the log archive (section 2.5). Alerts: any `AccessDenied` from an unexpected principal, any `DeleteObject*` outside the retention role,
    KMS throttling, any change to bucket policy, public access settings or key policy.
25. The metrics and alerts for retrievals (`integrity_failed`, `store_unavailable`, denials) are in [`observability-spec.md`](observability-spec.md).

### 2.10 Backup and recovery

26. Versioning protects against accidental overwrite and deletion. Cross-region replication to ap-south-2 is a **later** option (ADR 0010: disaster recovery to Hyderabad later) and needs its own key and policy decision.
    A restore of documents must be rehearsed together with the database restore ([`restore-drill.md`](restore-drill.md) lists this as not yet covered).

### 2.11 Content safety (separate from storage)

27. Storage does not make a file safe. Uploads are checked for type and active content in the API (shared validation is a separate remediation item, audit F-02). Malware scanning and per-lender quotas do not exist (audit R-06):
    decide whether to add a scanning step in India before documents are opened by other organisations' staff.

## 3. Test plan

No test below exists for the S3 adapter today; the fake-client tests in `packages/adapters/src/documents.test.ts` cover only the wrapper.

| Level                 | Test                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contract suite | One suite run against both the local store and the S3 client: round trip; checksum mismatch rejected; invalid and traversal keys rejected; second `put` to the same key refused; missing key returns `undefined`; `delete` is idempotent; a key with a lender name or PAN-shaped text is not generated.  |
| Adapter unit tests    | The hex SHA-256 is sent as a base64 `ChecksumSHA256`; `If-None-Match: *` is sent; the KMS key id is always present; AWS error text never escapes; timeouts return the documented unknown state.                                                                                                          |
| Infrastructure checks | Run in CI against the infrastructure code or a non-production account: Block Public Access on; ACLs disabled; default encryption is the expected CMK; policy denies unencrypted puts, wrong-key puts and non-TLS; bucket region is `ap-south-1`; no CORS; versioning on; archive bucket has Object Lock. |
| Negative access tests | In a non-production account: the API role cannot read the archive bucket; the staging role cannot decrypt a production-keyed object; a request from outside the allowed endpoint is denied; a public-ACL put is denied.                                                                                  |
| Failure injection     | S3 `5xx`, throttling, KMS `AccessDenied`, a timed-out `put` followed by `HEAD`, a tampered object (bytes changed out of band) returning `integrity_failed` and never the bytes.                                                                                                                          |
| API tests             | Existing: `503` when no store is configured. Add: with the S3 store selected and a fake client, uploads, generated documents and downloads behave as with the local store; orphan clean-up runs when the database insert fails; the hash mismatch path is exercised.                                     |
| Deletion hook dry run | When D-25 is decided: a due document is removed with all versions, the database records it, and a retrieval then answers not found; a legal-hold document is not removed.                                                                                                                                |
| Restore               | Restore the database and the document bucket from backups into a clean environment and retrieve a document with a matching hash.                                                                                                                                                                         |
| Review                | Update the threat model and the security checklist; run a security review of the adapter and the policies before any real document is stored; include the bucket and key policies in the infrastructure region inventory (ADR 0010 verification).                                                        |

## 4. Decisions needed from the owner

| Decision                                                                                | Why it blocks                                                           |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| AWS account and a named cost and operations owner (ADR 0010)                            | Nothing can be created without them.                                    |
| Key model: one key per environment first, per lender before any real lender data (D-47) | Lender due diligence is likely to require lender-controlled keys.       |
| Retention schedule and legal-hold rules (D-25), and whether any class needs Object Lock | The deletion hooks, lifecycle rules and versioning policy depend on it. |
| Approval to add the AWS SDK for S3 as a dependency                                      | This pass added no dependencies; the implementation will.               |
| Streaming through the API (this spec) or presigned URLs (ADR 0010 wording)              | Changes the hash-check and access-record design.                        |
| Whether the API role may delete just-written objects or a worker sweeper does it        | IAM design (item 11).                                                   |
| Malware scanning and quotas before documents cross organisations                        | Audit R-06.                                                             |
| Disaster recovery for documents (replication to ap-south-2)                             | D-28.                                                                   |

The primary-source verification gate in `docs/adr/README.md` applies to every regulatory reference in this document.
