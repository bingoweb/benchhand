export type DurableEntityKind =
  | 'artifact'
  | 'operation'
  | 'plugin'
  | 'plugin-instance'
  | 'process'
  | 'task'
  | 'terminal-session'
  | 'workspace';

declare const durableEntityIdBrand: unique symbol;

export type DurableEntityId<Kind extends DurableEntityKind> = string & {
  readonly [durableEntityIdBrand]: Kind;
};

export function parseEntityId<Kind extends DurableEntityKind>(
  kind: Kind,
  value: string,
): DurableEntityId<Kind> {
  if (value.length === 0) {
    throw new TypeError(`${kind} id must not be empty`);
  }

  return value as DurableEntityId<Kind>;
}
