import { AsyncLocalStorage } from 'node:async_hooks';

import { ProfileOperationError } from '../profile/errors.js';
import type { OutputLanguage } from '../profile/types.js';

const OUTPUT_LANGUAGE_ENV = 'LLMWIKI_OUTPUT_LANG';

export type CompilerLanguageLiteral = 'English' | 'Korean';

export interface OutputLanguageCoordinator {
  run<T>(language: OutputLanguage | null, operation: () => Promise<T>): Promise<T>;
}

export function compilerLanguageLiteral(language: OutputLanguage): CompilerLanguageLiteral {
  return language === 'en' ? 'English' : 'Korean';
}

class ProcessOutputLanguageCoordinator implements OutputLanguageCoordinator {
  readonly #context = new AsyncLocalStorage<boolean>();
  readonly #environment: NodeJS.ProcessEnv;
  #tail: Promise<void> = Promise.resolve();

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }

  async run<T>(language: OutputLanguage | null, operation: () => Promise<T>): Promise<T> {
    if (this.#context.getStore() === true) {
      throw new ProfileOperationError('PROFILE_LANGUAGE_CONFLICT');
    }
    const previous = this.#tail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = previous.then(() => current);
    await previous;
    const hadPrior = Object.hasOwn(this.#environment, OUTPUT_LANGUAGE_ENV);
    const prior = this.#environment[OUTPUT_LANGUAGE_ENV];
    try {
      if (language !== null) {
        this.#environment[OUTPUT_LANGUAGE_ENV] = compilerLanguageLiteral(language);
      }
      return await this.#context.run(true, operation);
    } finally {
      if (language !== null) {
        if (hadPrior && prior !== undefined) this.#environment[OUTPUT_LANGUAGE_ENV] = prior;
        else delete this.#environment[OUTPUT_LANGUAGE_ENV];
      }
      release?.();
    }
  }
}

export function createOutputLanguageCoordinator(
  environment: NodeJS.ProcessEnv = process.env,
): OutputLanguageCoordinator {
  return new ProcessOutputLanguageCoordinator(environment);
}

export const processOutputLanguageCoordinator: OutputLanguageCoordinator =
  createOutputLanguageCoordinator(process.env);
