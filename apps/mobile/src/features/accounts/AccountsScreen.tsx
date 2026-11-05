import { CONNECTOR_REGISTRY, freeSlotsLeft, withSlotUsage } from '@manaclaude/connectors/registry';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  classifyAccountType,
  type Account,
  type AccountType,
  type ColorSlot,
  type ConnectionStatus,
  type ConnectorDefinition,
  type ConnectorKind,
} from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, SegmentedControl, type BadgeTone } from '../../design/components/Controls';
import { Avatar, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';

const GROUPS: { title: string; types: AccountType[] }[] = [
  { title: 'Cash', types: ['cash'] },
  { title: 'Checking and savings', types: ['checking', 'savings'] },
  { title: 'Credit cards', types: ['credit_card'] },
  { title: 'Investments', types: ['brokerage', 'retirement'] },
  { title: 'Crypto', types: ['crypto'] },
  { title: 'Property and vehicles', types: ['property', 'vehicle', 'other_asset'] },
  { title: 'Loans', types: ['loan', 'mortgage', 'other_liability'] },
];

const STATUS: Record<ConnectionStatus, { label: string; tone: BadgeTone }> = {
  healthy: { label: 'Synced', tone: 'income' },
  syncing: { label: 'Syncing', tone: 'accent' },
  needs_repair: { label: 'Repair', tone: 'pending' },
  error: { label: 'Error', tone: 'danger' },
  disconnected: { label: 'Off', tone: 'neutral' },
};

const KIND_LABEL: Partial<Record<ConnectorKind, string>> = {
  bank: 'Banks and cards',
  brokerage: 'Brokerages',
  crypto: 'Crypto',
  property: 'Property and vehicles',
  market_data: 'Market data and FX',
};

function kindOf(c: ConnectorDefinition): ConnectorKind {
  if (c.kinds.includes('fx') || c.kinds.includes('market_data')) return 'market_data';
  if (c.kinds.includes('vehicle') || c.kinds.includes('property')) return 'property';
  if (c.kinds.includes('crypto') && c.kinds.length === 1) return 'crypto';
  if (c.kinds.includes('brokerage') && !c.kinds.includes('bank')) return 'brokerage';
  return 'bank';
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 48) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

const ACCOUNT_COLOR: Record<AccountType, ColorSlot> = {
  checking: 'c1',
  savings: 'c5',
  credit_card: 'c11',
  cash: 'c10',
  brokerage: 'c3',
  retirement: 'c4',
  crypto: 'c2',
  loan: 'c6',
  mortgage: 'c6',
  property: 'c7',
  vehicle: 'c9',
  other_asset: 'c12',
  other_liability: 'c8',
};

/**
 * Accounts and connectors (session A owns this screen; it adds linking,
 * repair flows and cash accounts).
 */
export function AccountsScreen() {
  const data = useFinance();
  const display = useMoneyDisplay();
  const [tab, setTab] = useState<'accounts' | 'connectors'>('accounts');
  const connectionsById = useMemo(
    () => new Map(data.connections.map((c) => [c.id, c])),
    [data.connections],
  );
  const registry = useMemo(
    () => withSlotUsage(data.connectorSlotsUsed, CONNECTOR_REGISTRY),
    [data.connectorSlotsUsed],
  );

  const accountRow = (a: Account) => {
    const conn = a.connectionId ? connectionsById.get(a.connectionId) : undefined;
    const liability = classifyAccountType(a.type) === 'liability';
    return (
      <ListRow
        key={a.id}
        title={a.name}
        subtitle={[
          a.institutionName,
          a.mask ? `••${a.mask}` : null,
          conn ? `synced ${ago(conn.lastSyncAt)}` : 'Manual',
        ]
          .filter(Boolean)
          .join(' · ')}
        leading={<Avatar label={a.institutionName ?? a.name} color={ACCOUNT_COLOR[a.type]} />}
        trailing={
          <VStack align="flex-end" gap="xxs">
            <Amount
              amount={liability ? -a.balance : a.balance}
              currency={a.currency}
              format={{ cents: 'auto' }}
            />
            {conn && conn.status !== 'healthy' ? (
              <Badge label={STATUS[conn.status].label} tone={STATUS[conn.status].tone} />
            ) : null}
          </VStack>
        }
        testID={`account-${a.id}`}
      />
    );
  };

  const connectorGroups = useMemo(() => {
    const map = new Map<ConnectorKind, ConnectorDefinition[]>();
    for (const c of registry) map.set(kindOf(c), [...(map.get(kindOf(c)) ?? []), c]);
    const order: Record<ConnectorDefinition['availability'], number> = {
      available: 0,
      paid: 1,
      unavailable: 2,
    };
    for (const list of map.values())
      list.sort((a, b) => order[a.availability] - order[b.availability]);
    return [...map.entries()];
  }, [registry]);

  return (
    <Screen title="Accounts" actions={<CurrencyChip />} testID="screen-accounts">
      <SegmentedControl
        accessibilityLabel="Show"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'accounts', label: 'Accounts' },
          { value: 'connectors', label: 'Connectors' },
        ]}
      />
      {tab === 'accounts' ? (
        <>
          {data.connections
            .filter((c) => c.status === 'needs_repair' || c.status === 'error')
            .map((c) => (
              <Card key={c.id} tone="accent">
                <VStack gap="sm">
                  <Text variant="bodyStrong">{`${c.institutionName} needs attention`}</Text>
                  <Text variant="caption" tone="muted">
                    {c.lastError ?? 'The connection stopped syncing.'}
                  </Text>
                  <HStack>
                    <Button
                      label="Repair connection"
                      size="sm"
                      icon="refresh-cw"
                      onPress={() => haptic('confirm')}
                    />
                  </HStack>
                </VStack>
              </Card>
            ))}
          {GROUPS.map((g) => {
            const accounts = data.accounts.filter((a) => g.types.includes(a.type) && !a.hidden);
            if (accounts.length === 0) return null;
            const total = display.total(
              accounts.map((a) => ({
                amount: classifyAccountType(a.type) === 'liability' ? -a.balance : a.balance,
                currency: a.currency,
              })),
            );
            return (
              <View key={g.title}>
                <SectionHeader
                  title={g.title}
                  trailing={
                    <MoneyText
                      amount={total.amount}
                      currency={total.currency}
                      size="small"
                      tone="muted"
                      format={{ cents: 'never' }}
                    />
                  }
                />
                <Card padding="none">{accounts.map(accountRow)}</Card>
              </View>
            );
          })}
        </>
      ) : (
        <>
          <Text variant="caption" tone="muted">
            Personal access only. Free connectors come first; lifetime logins never come back, so
            repair a broken connection instead of removing it.
          </Text>
          {connectorGroups.map(([kind, list]) => (
            <View key={kind}>
              <SectionHeader title={KIND_LABEL[kind] ?? kind} />
              <Card padding="none">
                {list.map((c) => {
                  const left = freeSlotsLeft(c);
                  const active = data.connections.filter((x) => x.connectorId === c.id);
                  const unavailable = c.availability === 'unavailable';
                  const slots =
                    c.freeSlotsTotal === null
                      ? 'No slot limit'
                      : c.freeSlotsTotal === 0
                        ? c.cost
                        : `${left} of ${c.freeSlotsTotal} free ${c.slotsAreLifetime ? 'lifetime logins' : 'connections'} left`;
                  return (
                    <ListRow
                      key={c.id}
                      title={c.name}
                      subtitle={
                        unavailable
                          ? (c.reason ?? 'Unavailable')
                          : `${slots}${active.length ? ` · ${active.length} linked` : ''}`
                      }
                      leading={
                        <IconBadge
                          icon={
                            unavailable
                              ? 'lock'
                              : c.kinds.includes('crypto')
                                ? 'coins'
                                : c.kinds.includes('brokerage')
                                  ? 'trending-up'
                                  : 'building'
                          }
                          color={unavailable ? 'c12' : 'c1'}
                        />
                      }
                      trailing={
                        <Badge
                          label={
                            unavailable
                              ? 'Unavailable'
                              : c.availability === 'paid'
                                ? 'Paid'
                                : active.some((x) => x.status === 'needs_repair')
                                  ? 'Repair'
                                  : active.length
                                    ? 'Linked'
                                    : 'Free'
                          }
                          tone={
                            unavailable
                              ? 'neutral'
                              : c.availability === 'paid'
                                ? 'pending'
                                : active.some((x) => x.status === 'needs_repair')
                                  ? 'pending'
                                  : active.length
                                    ? 'income'
                                    : 'accent'
                          }
                        />
                      }
                      dimmed={unavailable}
                      testID={`connector-${c.id}`}
                    />
                  );
                })}
              </Card>
            </View>
          ))}
        </>
      )}
    </Screen>
  );
}
