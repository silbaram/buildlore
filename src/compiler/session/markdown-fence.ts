export interface SessionMarkdownFence {
  readonly marker: '`' | '~';
  readonly minimumLength: number;
}

export interface SessionMarkdownFenceTransition {
  readonly fence: SessionMarkdownFence | null;
  readonly isFenceLine: boolean;
}

const OPENING_FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;

export function transitionSessionMarkdownFence(
  line: string,
  current: SessionMarkdownFence | null,
): SessionMarkdownFenceTransition {
  if (current !== null) {
    const closingRun = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
    return closingRun !== undefined && closingRun[0] === current.marker &&
      closingRun.length >= current.minimumLength
      ? Object.freeze({ fence: null, isFenceLine: true })
      : Object.freeze({ fence: current, isFenceLine: false });
  }

  const opening = OPENING_FENCE_PATTERN.exec(line);
  const run = opening?.[2];
  const info = opening?.[3] ?? '';
  if (run === undefined || (run.startsWith('`') && info.includes('`'))) {
    return Object.freeze({ fence: null, isFenceLine: false });
  }
  return Object.freeze({
    fence: Object.freeze({
      marker: run[0] as '`' | '~',
      minimumLength: run.length,
    }),
    isFenceLine: true,
  });
}
