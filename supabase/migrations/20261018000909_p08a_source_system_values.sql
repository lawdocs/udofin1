-- =============================================================================================
-- Phase 08a, servicing sync (stream SERVICING SYNC AND FILE IMPORT), part 1 of 2.
--
-- New values for servicing.source_system: where a loan report came from.
--   file_import  a lender-supplied file in the udofin-lms-import-v1 format, committed through servicing.commit_import
--   mock_lms     the labelled mock LMS (local development and tests only; the connection kind `mock` is guarded)
-- `manual_import` already exists and stays the value for hand-keyed entries.
--
-- A new enum value cannot be used in the same transaction that adds it, so this file contains nothing else; the
-- tables and functions that use the values are in 20261018000911_p08a_servicing_sync.sql.
-- =============================================================================================

alter type servicing.source_system add value if not exists 'file_import';
alter type servicing.source_system add value if not exists 'mock_lms';
