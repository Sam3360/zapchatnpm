/**
 * Renders the timeline viewport: one Ink row per visual line, one line each.
 *
 * `wrap` is set to `truncate-end` even though lines are pre-wrapped, purely as a
 * belt-and-braces guarantee that a row can never spill onto a second line and
 * shift the whole frame (including when a terminal measures a glyph differently
 * than `string-width` does).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { VisualLine } from '../view/timeline.js';

export function TimelineView({
  lines,
  width,
}: {
  lines: readonly VisualLine[];
  width: number;
}): ReactNode {
  return (
    <>
      {lines.map(line => (
        <Box key={line.key} height={1} width={width} overflow="hidden">
          <Text wrap="truncate-end">
            {line.spans.map((span, index) => (
              <Text
                key={`${index}-${span.text}`}
                color={span.color}
                dimColor={span.dim}
                bold={span.bold}
                inverse={span.inverse}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </>
  );
}

/** Plain placeholder rows (used when a room is empty). */
export function PlainRows({
  rows,
  width,
  dim = true,
}: {
  rows: readonly string[];
  width: number;
  dim?: boolean;
}): ReactNode {
  return (
    <>
      {rows.map((row, index) => (
        <Box
          key={`row-${index}`}
          height={1}
          width={width}
          overflow="hidden"
        >
          <Text wrap="truncate-end" dimColor={dim}>
            {row}
          </Text>
        </Box>
      ))}
    </>
  );
}
