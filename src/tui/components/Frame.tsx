/**
 * Structural chrome: one bordered frame, plus the rows every screen shares.
 *
 * Every child of a frame renders exactly one terminal row. That invariant keeps
 * the frame height stable, which is what makes the scrollable body reliable.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { theme, glyphs } from '../theme.js';
import type { ScreenLayout } from '../view/layout.js';
import { renderPrompt } from '../view/prompt.js';
import { divider } from '../view/text.js';
import { composeRow, type RowSpan } from '../view/rows.js';
import type { StatusDescription } from '../view/status.js';
import type { EditorState } from '../input/lineEditor.js';

export interface FrameProps {
  layout: ScreenLayout;
  children: ReactNode;
}

/** The outer rounded frame. Height is fixed so the terminal never scrolls. */
export function Frame({ layout, children }: FrameProps) {
  return (
    <Box
      flexDirection="column"
      width={layout.frameWidth}
      height={layout.frameHeight}
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}

/** One row built from a span list, with an optional right-aligned label. */
export function SpanRow({
  layout,
  spans,
  right = '',
  rightColor = theme.muted,
  prefix = '',
}: {
  layout: ScreenLayout;
  spans: RowSpan[];
  right?: string;
  rightColor?: string;
  prefix?: string;
}): ReactNode {
  const row = composeRow(
    prefix.length > 0 ? [{ text: prefix }, ...spans] : spans,
    right,
    layout.innerWidth,
  );

  return (
    <Box height={1} width={layout.innerWidth} overflow="hidden">
      <Text wrap="truncate-end">
        {row.left.map((span, index) => (
          <Text
            key={`${index}-${span.text}`}
            color={span.color}
            dimColor={span.dim}
            bold={span.bold}
          >
            {span.text}
          </Text>
        ))}
        <Text>{row.gap}</Text>
        {row.right.length > 0 ? <Text color={rightColor}>{row.right}</Text> : null}
      </Text>
    </Box>
  );
}

export function Divider({ layout }: { layout: ScreenLayout }): ReactNode {
  return (
    <Box height={1} width={layout.innerWidth} overflow="hidden">
      <Text dimColor>{divider(layout.innerWidth)}</Text>
    </Box>
  );
}

export interface HeaderBarProps {
  layout: ScreenLayout;
  username: string;
  /** First row, right side: connection status badge. */
  status: StatusDescription;
  /** Second row, left side: where we are (`#general`, `lobby`, `welcome`). */
  contextLabel: string;
  contextColor?: string;
  /** Second row, right side: population summary. */
  summary: string;
  summaryColor?: string;
  /** Dim detail on the first row (ports, LAN address). */
  detail?: string;
}

export function HeaderBar({
  layout,
  username,
  status,
  contextLabel,
  contextColor = theme.accent,
  summary,
  summaryColor,
  detail,
}: HeaderBarProps): ReactNode {
  return (
    <>
      <SpanRow
        layout={layout}
        spans={[
          { text: 'zapchat', bold: true, color: theme.title },
          { text: ` ${username}`, dim: true },
        ]}
        right={`${glyphs.dot} ${status.label}${detail === undefined ? '' : `  ${detail}`}`}
        rightColor={status.color}
      />
      <SpanRow
        layout={layout}
        spans={[{ text: contextLabel, bold: true, color: contextColor }]}
        right={summary}
        rightColor={summaryColor ?? theme.muted}
      />
      <Divider layout={layout} />
    </>
  );
}

export interface PromptRowProps {
  layout: ScreenLayout;
  state: EditorState;
  placeholder: string;
  focused?: boolean;
}

export function PromptRow({ layout, state, placeholder, focused = true }: PromptRowProps): ReactNode {
  const rendered = renderPrompt(state.text, state.cursor, {
    maxWidth: Math.max(1, layout.innerWidth - 2),
    placeholder,
  });

  return (
    <Box height={1} width={layout.innerWidth} overflow="hidden">
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {`${glyphs.prompt} `}
        </Text>
        {rendered.placeholder && focused ? (
          <Text dimColor>{rendered.before}</Text>
        ) : (
          <Text>{rendered.before}</Text>
        )}
        {focused && rendered.cursor.length > 0 ? (
          <Text inverse>{rendered.cursor}</Text>
        ) : (
          <Text>{rendered.cursor}</Text>
        )}
        <Text>{rendered.after}</Text>
      </Text>
    </Box>
  );
}

export interface HintRowProps {
  layout: ScreenLayout;
  left: string;
  leftColor?: string;
  right?: string;
  rightColor?: string;
  leftDim?: boolean;
}

export function HintRow({
  layout,
  left,
  leftColor,
  right = '',
  rightColor,
  leftDim = true,
}: HintRowProps): ReactNode {
  return (
    <SpanRow
      layout={layout}
      spans={[{ text: left, color: leftColor, dim: leftDim }]}
      right={right}
      rightColor={rightColor ?? theme.muted}
    />
  );
}

/** Blank filler row, used to keep the frame height exactly right. */
export function BlankRow(): ReactNode {
  return (
    <Box height={1}>
      <Text> </Text>
    </Box>
  );
}
