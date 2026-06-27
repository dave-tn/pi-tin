/**
 * Wraps an async function to handle ExitPromptError from @inquirer/prompts.
 * When the user presses Ctrl+C during a prompt, prints a goodbye message and exits cleanly.
 */
export async function withExitHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log('\nGoodbye!');
      process.exit(0);
    }
    throw err;
  }
}
