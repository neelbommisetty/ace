import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves the workspace root by walking up from startCwd until a `questions/` directory is found.
 * If no questions/ is found, returns startCwd.
 */
export function resolveWorkspaceRoot(startCwd: string = process.cwd()): string {
  let current = path.resolve(startCwd);
  const root = path.parse(current).root;

  while (current !== root) {
    const questionsPath = path.join(current, 'questions');
    if (fs.existsSync(questionsPath) && fs.statSync(questionsPath).isDirectory()) {
      return current;
    }
    current = path.dirname(current);
  }

  // Check root itself
  const questionsPath = path.join(current, 'questions');
  if (fs.existsSync(questionsPath) && fs.statSync(questionsPath).isDirectory()) {
    return current;
  }

  // No questions/ found, return starting directory
  return path.resolve(startCwd);
}

/**
 * Returns the questions directory path for a given workspace root.
 */
export function getQuestionsDir(root: string): string {
  return path.join(root, 'questions');
}

/**
 * Checks if a workspace is initialized (has a questions/ directory).
 */
export function isWorkspaceInitialized(root: string): boolean {
  const questionsPath = getQuestionsDir(root);
  return fs.existsSync(questionsPath) && fs.statSync(questionsPath).isDirectory();
}

/**
 * Returns the user's home directory.
 */
export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~';
}

/**
 * Returns the global ace directory path in the user's home.
 */
export function getGlobalAceDir(): string {
  return path.join(getHomeDir(), '.ace');
}
