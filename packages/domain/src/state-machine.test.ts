import { describe, expect, it } from 'vitest';
import { defineStateMachine, InvalidTransitionError } from './state-machine.js';

type Door = 'closed' | 'open' | 'locked' | 'removed';

const door = defineStateMachine<Door>({
  name: 'door',
  states: ['closed', 'open', 'locked', 'removed'],
  initial: 'closed',
  terminal: ['removed'],
  transitions: {
    closed: ['open', 'locked', 'removed'],
    open: ['closed'],
    locked: ['closed'],
  },
});

describe('defineStateMachine', () => {
  it('allows only declared transitions', () => {
    expect(door.canTransition('closed', 'open')).toBe(true);
    expect(door.canTransition('open', 'locked')).toBe(false);
    expect(() => door.assertTransition('open', 'locked')).toThrow(InvalidTransitionError);
  });

  it('treats terminal states as final', () => {
    expect(door.isTerminal('removed')).toBe(true);
    expect(door.nextStates('removed')).toEqual([]);
  });

  it('rejects definitions with undeclared states', () => {
    expect(() =>
      defineStateMachine<'a' | 'b'>({
        name: 'bad',
        states: ['a'] as ('a' | 'b')[],
        initial: 'a',
        terminal: [],
        transitions: { a: ['b'] },
      }),
    ).toThrow(/not declared/);
  });

  it('rejects transitions out of terminal states and self-transitions', () => {
    expect(() =>
      defineStateMachine<'a' | 'b'>({
        name: 'bad',
        states: ['a', 'b'],
        initial: 'a',
        terminal: ['b'],
        transitions: { a: ['b'], b: ['a'] },
      }),
    ).toThrow(/terminal/);
    expect(() =>
      defineStateMachine<'a' | 'b'>({
        name: 'bad',
        states: ['a', 'b'],
        initial: 'a',
        terminal: [],
        transitions: { a: ['a'] },
      }),
    ).toThrow(/self-transition/);
  });
});
