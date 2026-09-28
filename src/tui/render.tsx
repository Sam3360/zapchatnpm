/**
 * Mounting the TUI.
 *
 * Terminal safety is the priority here:
 *  - the alternate screen buffer is used by default, so the user's scrollback is
 *    untouched while zapchat is running and restored when it exits;
 *  - Ctrl+C is handled by the app (not by Ink) so shutdown is graceful;
 *  - SIGTERM/SIGHUP and unexpected exceptions unmount Ink first, which restores
 *    the terminal, and only then report the error.
 */

import { render } from 'ink';
import type { ZapClient } from '../core/client.js';
import { App } from './App.js';

export interface RunTuiOptions {
  client: ZapClient;
  /** Use the alternate screen buffer (default true when the terminal supports it). */
  alternateScreen?: boolean;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const instance = render(<App client={options.client} />, {
    exitOnCtrlC: false,
    alternateScreen: options.alternateScreen ?? true,
    // Cap the refresh rate: LAN heartbeats can fire often, and a churning frame
    // rate is what makes a TUI feel flickery.
    maxFps: 30,
  });

  const unmount = (): void => {
    try {
      instance.unmount();
    } catch {
      // Already unmounted.
    }
  };

  const onSignal = (): void => {
    void options.client
      .stop()
      .catch(() => undefined)
      .then(unmount);
  };

  const onFatal = (error: Error): void => {
    unmount();
    process.stderr.write(
      `\nzapchat stopped after an unexpected error:\n${error.stack ?? error.message}\n`,
    );
    process.exit(1);
  };

  const onRejection = (reason: unknown): void => {
    onFatal(reason instanceof Error ? reason : new Error(String(reason)));
  };

  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onRejection);

  try {
    await instance.waitUntilExit();
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onRejection);

    try {
      instance.cleanup();
    } catch {
      // Nothing else to do: the process is on its way out.
    }
  }
}
