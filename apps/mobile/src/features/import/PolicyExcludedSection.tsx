import { useState } from 'react';
import { formatMoney, type Account, type ImportPreview } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';

const SHOWN = 20;

type Info = NonNullable<ImportPreview['historyPolicy']>;

/** A row's amount in its own currency: the file's, else its account's. */
function rowAmount(
  r: Info['excludedRows'][number],
  accounts: readonly Account[],
  totals: Info['excludedTotals'],
): string {
  const currency =
    r.currency ??
    accounts.find((a) => a.id === r.accountId)?.currency ??
    totals.find((t) => t.accountId === r.accountId)?.currency ??
    null;
  return currency ? formatMoney(r.amount, currency) : String(r.amount / 100);
}

/** The plain-words summary of rows History sources leaves out, or null when none. */
export function policyExcludedText(preview: ImportPreview): string | null {
  const n = preview.historyPolicy?.excludedCount ?? 0;
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'row is' : 'rows are'} left out by History sources: the bank owns ${n === 1 ? 'its date' : 'those dates'} for ${n === 1 ? 'its account' : 'their accounts'}. ${n === 1 ? 'It is' : 'They are'} not saved and not errors; the counts and totals above are without ${n === 1 ? 'it' : 'them'}.`;
}

/**
 * Rows of a Monefy file that the history settings give to the bank, kept
 * apart from unreadable lines, rows outside the chosen dates and rows left
 * out by hand. The totals are as written in the file.
 */
export function PolicyExcludedSection({
  preview,
  accounts,
}: {
  preview: ImportPreview;
  accounts: readonly Account[];
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(SHOWN);
  const info = preview.historyPolicy;
  const text = policyExcludedText(preview);
  if (!info || !text) return null;
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'an account';
  return (
    <VStack gap="xs" testID="import-policy">
      <Text variant="caption" tone="muted" testID="import-policy-excluded">
        {text}
      </Text>
      {info.excludedTotals.map((t) => (
        <Text
          key={`${t.accountId}-${t.currency}`}
          variant="caption"
          tone="muted"
          testID={`import-policy-total-${t.accountId}-${t.currency}`}
        >
          {`"${name(t.accountId)}": ${t.count} ${t.count === 1 ? 'row' : 'rows'}, ${formatMoney(t.outflow, t.currency)} out, ${formatMoney(t.inflow, t.currency)} in`}
        </Text>
      ))}
      <HStack>
        <Button
          label={open ? 'Hide these rows' : 'Show these rows'}
          size="sm"
          variant="ghost"
          onPress={() => setOpen((o) => !o)}
          testID="import-policy-toggle"
        />
      </HStack>
      {open
        ? info.excludedRows.slice(0, shown).map((r) => (
            <HStack
              key={`${r.line}-${r.date}`}
              justify="space-between"
              gap="sm"
              testID={`import-policy-row-${r.line}`}
            >
              <VStack gap="xxs" flex={1}>
                <Text variant="caption">{r.rawName || r.categoryName || 'No description'}</Text>
                <Text variant="caption" tone="muted">
                  {`Line ${r.line} · ${r.date} · ${r.exclusionReason === 'replacement_month' ? 'a month the bank replaces' : 'on or after the bank cutoff'}`}
                </Text>
              </VStack>
              <Text variant="caption" numeric>
                {rowAmount(r, accounts, info.excludedTotals)}
              </Text>
            </HStack>
          ))
        : null}
      {open && info.excludedRows.length > shown ? (
        <HStack>
          <Button
            label={`Show ${Math.min(SHOWN, info.excludedRows.length - shown)} more`}
            size="sm"
            variant="ghost"
            onPress={() => setShown((n) => n + SHOWN)}
          />
        </HStack>
      ) : null}
    </VStack>
  );
}
