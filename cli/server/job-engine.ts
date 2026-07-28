import { NoObjectGeneratedError } from 'ai';

/**
 * Shared lifecycle bookkeeping for the LLM job engines (reviews, disputes,
 * generation, brainstorm — NEE-300). Every engine has the same shape: an
 * in-flight collection keyed by question/session/job id, a disposed flag
 * flipped by session teardown, and the same guards around both. Each engine
 * keeps its own runJob — prompt assembly, streaming, persistence — and
 * delegates the bookkeeping here, so the four copies can't drift apart
 * again (before this module, only two of the four applied the release
 * identity guard).
 *
 * `K` is the in-flight key (question/session id); `J` is the job identity
 * stored against it — a job id string, or a richer per-job object (reviews
 * stores its ReviewJob so dispose() can reach the flush timers). Engines
 * whose key IS the job identity (generation, brainstorm) use the `J = K`
 * default and pass the same id to both parameters.
 */
export interface JobRegistry<K, J = K> {
  /** Guard for the public start methods: throws once dispose() has run. */
  assertNotDisposed(): void;
  /**
   * True once dispose() has run. Engines must consult this after every
   * awaited LLM call (and before every bus emit): a paid call that resolves
   * after dispose() must not write through a db the session teardown may
   * already be closing (or have closed).
   */
  isDisposed(): boolean;
  /**
   * Duplicate-start guard: throws `message` when `key` already has a job in
   * flight. Routes check isRunning/isThinking first (that's the 409); this
   * is a programming-error backstop.
   */
  assertNotRunning(key: K, message: string): void;
  /** Registers `job` as the in-flight job for `key`. */
  claim(key: K, job: J): void;
  /**
   * Removes `key` from the in-flight collection — but only while it is still
   * held by this exact `job` (identity guard): once dispose() has cleared
   * the collection, or a later job has re-claimed the key, a stale runJob's
   * finally block must not release an entry it no longer owns.
   */
  release(key: K, job: J): void;
  isRunning(key: K): boolean;
  isAnyRunning(): boolean;
  runningCount(): number;
  /**
   * The in-flight jobs, for engine-specific teardown the registry can't own
   * (reviews clears its pending chunk-flush timers before disposing).
   */
  jobs(): IterableIterator<J>;
  /** Flips the disposed flag and empties the in-flight collection. */
  dispose(): void;
}

/** Creates the registry; `name` feeds the "<name> engine is disposed" error. */
export function createJobRegistry<K, J = K>(opts: { name: string }): JobRegistry<K, J> {
  const { name } = opts;
  const inFlight = new Map<K, J>();
  let disposed = false;

  return {
    assertNotDisposed() {
      if (disposed) throw new Error(`${name} engine is disposed`);
    },

    isDisposed() {
      return disposed;
    },

    assertNotRunning(key, message) {
      if (inFlight.has(key)) throw new Error(message);
    },

    claim(key, job) {
      inFlight.set(key, job);
    },

    release(key, job) {
      if (inFlight.get(key) === job) inFlight.delete(key);
    },

    isRunning(key) {
      return inFlight.has(key);
    },

    isAnyRunning() {
      return inFlight.size > 0;
    },

    runningCount() {
      return inFlight.size;
    },

    jobs() {
      return inFlight.values();
    },

    dispose() {
      disposed = true;
      inFlight.clear();
    },
  };
}

/**
 * Normalises an engine failure into the message persisted/emitted to the
 * user: NoObjectGeneratedError (the model answered, but not with the
 * structured shape we paid for) gets the engine's friendly `fallback`
 * because its own message is schema-internals noise; everything else keeps
 * its message.
 */
export function toEngineErrorMessage(err: unknown, fallback: string): string {
  if (NoObjectGeneratedError.isInstance(err)) return fallback;
  return err instanceof Error ? err.message : String(err);
}
