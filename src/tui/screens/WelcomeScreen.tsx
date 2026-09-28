/**
 * First-run screen: pick a display name while discovery warms up.
 *
 * The suggested name comes from the OS account, so in most cases the user can
 * just press Enter.
 */

import { Box, Text, useInput } from 'ink';
import { useState, type ReactNode } from 'react';
import type { Snapshot, ZapClient } from '../../core/client.js';
import { sanitizeUsername } from '../../protocol/sanitize.js';
import { theme, glyphs } from '../theme.js';
import type { ScreenLayout } from '../view/layout.js';
import { describeStatus } from '../view/status.js';
import { Frame, PromptRow } from '../components/Frame.js';
import type { LineEditor } from '../hooks.js';
import { TAGLINE } from '../../version.js';

export interface WelcomeScreenProps {
  layout: ScreenLayout;
  snapshot: Snapshot;
  client: ZapClient;
  editor: LineEditor;
}

export function WelcomeScreen({
  layout,
  snapshot,
  client,
  editor,
}: WelcomeScreenProps): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const status = describeStatus(snapshot);
  const cardWidth = Math.min(layout.innerWidth - 4, 46);
  const hint = 'enter to continue · ctrl+c to quit';

  useInput((input, key) => {
    const action = editor.handleKey({ input, ...key });

    if (action === 'submit') {
      const value = editor.read().text;
      const username = sanitizeUsername(value);
      if (username === null) {
        setError('1-20 characters: letters, numbers, . _ -');
        return;
      }

      const result = client.setUsername(username);
      if (!result.ok) {
        setError(result.error ?? 'could not set that username');
        return;
      }

      setError(null);
      editor.reset();
      return;
    }

    if (action === 'cancel') {
      editor.reset();
      setError(null);
    }
  });

  return (
    <Frame layout={layout}>
      <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Text bold color={theme.title}>
          Welcome to zapchat
        </Text>
        <Text dimColor>{TAGLINE}</Text>

        <Box height={1} />

        <Text>What should people call you?</Text>
        <Box width={cardWidth}>
          <PromptRow
            layout={{ ...layout, innerWidth: cardWidth }}
            state={editor.state}
            placeholder="your name"
          />
        </Box>

        {error === null ? (
          <Text> </Text>
        ) : (
          <Text color={theme.error}>{error}</Text>
        )}

        <Box height={1} />

        <Text color={status.color}>
          {glyphs.dot} {status.label}
        </Text>
        <Text dimColor>{status.detail}</Text>

        <Box height={1} />

        <Text dimColor>{hint}</Text>
      </Box>
    </Frame>
  );
}
