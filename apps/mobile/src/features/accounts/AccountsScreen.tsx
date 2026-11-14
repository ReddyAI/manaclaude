import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  classifyAccountType,
  type Account,
  type AccountType,
  type ColorSlot,
} from '@manaclaude/shared';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, SegmentedControl } from '../../design/components/Controls';
import { Avatar, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { isBalanceUnknown } from '../../data/manualBalance';
import { useFinance } from '../../data/store';
import { useRefreshControl } from '../../data/backend/useRefreshControl';
import { ConnectionsCard } from '../link/ConnectionsCard';
import { startRepair } from '../link/repair';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';
import { CashQuickAddButton } from '../transactions/CashQuickAdd';
import { CashAccountSheet } from './CashAccountSheet';
import { ConnectorsList } from './ConnectorsList';
import { connectionHealth, timeAgo } from './health';

const GROUPS: { title: string; types: AccountType[] }[] = [
  { title: 'Cash', types: ['cash'] },
  { title: 'Checking and savings', types: ['checking', 'savings'] },
  { title: 'Credit cards', types: ['credit_card'] },
  { title: 'Investments', types: ['brokerage', 'retirement'] },
  { title: 'Crypto', types: ['crypto'] },
  { title: 'Property and vehicles', types: ['property', 'vehicle', 'other_asset'] },
  { title: 'Loans', types: ['loan', 'mortgage', 'other_liability'] },
];

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
 * Accounts and connectors (session A owns this screen). The Accounts tab
 * groups accounts and opens one account's transactions; the Connectors tab
 * lists every connector with status, free slots left and last sync.
 */
export function AccountsScreen() {
  const data = useFinance();
  const display = useMoneyDisplay();
  const [tab, setTab] = useState<'accounts' | 'connectors'>('accounts');
  const [repairNote, setRepairNote] = useState<Record<string, string>>({});
  const [addingCash, setAddingCash] = useState(false);
  const refreshControl = useRefreshControl();
  const connectionsById = new Map(data.connections.map((c) => [c.id, c]));

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
          conn ? `synced ${timeAgo(conn.lastSyncAt)}` : 'Manual',
        ]
          .filter(Boolean)
          .join(' · ')}
        leading={<Avatar label={a.institutionName ?? a.name} color={ACCOUNT_COLOR[a.type]} />}
        trailing={
          <VStack align="flex-end" gap="xxs">
            {isBalanceUnknown(a) ? (
              <Text variant="caption" tone="muted" testID={`account-unknown-${a.id}`}>
                Balance unknown
              </Text>
            ) : (
              <Amount
                amount={liability ? -a.balance : a.balance}
                currency={a.currency}
                format={{ cents: 'auto' }}
              />
            )}
            {conn && conn.status !== 'healthy' ? (
              <Badge label={connectionHealth(conn).label} tone={connectionHealth(conn).tone} />
            ) : null}
          </VStack>
        }
        onPress={() => router.push({ pathname: '/accounts/[id]', params: { id: a.id } })}
        showChevron
        testID={`account-${a.id}`}
      />
    );
  };

  return (
    <Screen
      title="Accounts"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="plus"
            accessibilityLabel="Add account"
            onPress={() => router.push('/link')}
            testID="add-account"
          />
          <CurrencyChip />
        </HStack>
      }
      overlay={<CashQuickAddButton />}
      refreshControl={refreshControl}
      testID="screen-accounts"
    >
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
                    {repairNote[c.id] ?? c.lastError ?? 'The connection stopped syncing.'}
                  </Text>
                  <HStack>
                    <Button
                      label={
                        c.connectorId === 'zerodha_kite' ? 'Log in to Zerodha' : 'Repair connection'
                      }
                      size="sm"
                      icon="refresh-cw"
                      testID={`repair-banner-${c.id}`}
                      onPress={() => {
                        haptic('confirm');
                        void startRepair(c).then(
                          (note) => note && setRepairNote((n) => ({ ...n, [c.id]: note })),
                        );
                      }}
                    />
                  </HStack>
                </VStack>
              </Card>
            ))}
          {GROUPS.map((g) => {
            const accounts = data.accounts.filter((a) => g.types.includes(a.type) && !a.hidden);
            if (accounts.length === 0) return null;
            // An account whose balance nobody entered adds nothing to its group's total.
            const total = display.total(
              accounts
                .filter((a) => !isBalanceUnknown(a))
                .map((a) => ({
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
          <HStack gap="sm" wrap>
            <Button
              label="Add account"
              icon="plus"
              size="sm"
              onPress={() => router.push('/link')}
            />
            <Button
              label="Import a statement"
              icon="file-up"
              size="sm"
              variant="secondary"
              onPress={() => router.push('/import')}
            />
            <Button
              label="Add a cash account"
              icon="wallet"
              size="sm"
              variant="secondary"
              onPress={() => setAddingCash(true)}
              testID="add-cash-account"
            />
            <Button
              label="Stored statements"
              icon="paperclip"
              size="sm"
              variant="ghost"
              onPress={() => router.push('/vault')}
              testID="open-vault"
            />
          </HStack>
          <CashAccountSheet visible={addingCash} onClose={() => setAddingCash(false)} />
          <ConnectionsCard />
          <ConnectorsList />
        </>
      )}
    </Screen>
  );
}
