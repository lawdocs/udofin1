/**
 * Declarative state machines for lifecycle entities (applications, loans, complaints, mandates...).
 * Each lifecycle is defined once as data; services ask the machine whether a transition is allowed
 * instead of scattering status checks. The database enforces the same table with a trigger.
 */

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';

  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machine}: transition ${from} -> ${to} is not allowed`);
  }
}

export interface StateMachineDefinition<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: S;
  /** States from which no further transition is allowed. */
  readonly terminal: readonly S[];
  readonly transitions: Readonly<Partial<Record<S, readonly S[]>>>;
}

export interface StateMachine<S extends string> {
  readonly definition: StateMachineDefinition<S>;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  nextStates(from: S): readonly S[];
  isTerminal(state: S): boolean;
}

export function defineStateMachine<S extends string>(
  definition: StateMachineDefinition<S>,
): StateMachine<S> {
  const known = new Set<S>(definition.states);
  const check = (state: S, role: string): void => {
    if (!known.has(state)) {
      throw new Error(`${definition.name}: ${role} state "${state}" is not declared`);
    }
  };

  check(definition.initial, 'initial');
  for (const state of definition.terminal) {
    check(state, 'terminal');
    if ((definition.transitions[state] ?? []).length > 0) {
      throw new Error(`${definition.name}: terminal state "${state}" must not have transitions`);
    }
  }
  for (const [from, targets] of Object.entries(definition.transitions) as [S, readonly S[]][]) {
    check(from, 'source');
    for (const to of targets) {
      check(to, 'target');
      if (to === from) {
        throw new Error(`${definition.name}: self-transition on "${from}" is not allowed`);
      }
    }
  }

  const terminal = new Set<S>(definition.terminal);
  const nextStates = (from: S): readonly S[] => definition.transitions[from] ?? [];

  return Object.freeze({
    definition,
    nextStates,
    isTerminal: (state: S) => terminal.has(state),
    canTransition: (from: S, to: S) => nextStates(from).includes(to),
    assertTransition(from: S, to: S) {
      if (!nextStates(from).includes(to)) {
        throw new InvalidTransitionError(definition.name, from, to);
      }
    },
  });
}
