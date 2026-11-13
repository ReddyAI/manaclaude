import type { Rule } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, Switch } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { PressableScale } from '../../design/components/PressableScale';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { BackAction } from '../planning/BackAction';
import {
  applyRulesNow,
  rulesStore,
  setRuleEnabled,
  setRulesNotice,
  useRulesNotice,
} from './actions';
import { describeRule } from './rules';
import { useRuleNames } from './useRuleNames';

/**
 * Rules from the Worker (GET /v1/rules), lowest priority number first. Each
 * can be turned on and off here, opened to change or delete it, and all of
 * them can be applied to the transactions already stored.
 */
export function RulesScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value: rules, loading, error } = rulesStore.use();
  const notice = useRulesNotice();
  const names = useRuleNames();
  const { theme } = useUnistyles();
  const [pulling, setPulling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [problemScope, setProblemScope] = useState(config.scope);
  if (problemScope !== config.scope) {
    setProblemScope(config.scope);
    setProblem(null);
  }

  useEffect(() => {
    if (ready) void rulesStore.load();
  }, [ready, config.scope]);
  // A line about the last change belongs to this visit of the list and this backend only.
  useEffect(() => () => setRulesNotice(null), []);
  const shownScope = useRef(config.scope);
  useEffect(() => {
    if (shownScope.current === config.scope) return;
    shownScope.current = config.scope;
    setRulesNotice(null);
  }, [config.scope]);

  if (!ready) {
    return (
      <Screen title="Rules" actions={<BackAction fallback="/settings" />} testID="screen-rules">
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Rules are kept and run by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const run = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setProblem(null);
    setRulesNotice(null);
    try {
      await work();
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const row = (rule: Rule) => (
    <View key={rule.id} style={styles.row} testID={`rule-${rule.id}`}>
      <HStack gap="md" align="center">
        <PressableScale
          onPress={() => router.push({ pathname: '/rules/[id]', params: { id: rule.id } })}
          accessibilityLabel={`${rule.name}, change`}
          pressHaptic="tap"
          containerStyle={styles.body}
          testID={`rule-open-${rule.id}`}
        >
          <VStack gap="xxs">
            <HStack gap="xs" align="center" wrap>
              <Text variant="bodyStrong" numberOfLines={1}>
                {rule.name}
              </Text>
              {!rule.enabled ? <Badge label="Off" /> : null}
              {rule.source === 'learned' ? <Badge label="Learned" tone="accent" /> : null}
            </HStack>
            <Text variant="caption" tone="muted" numberOfLines={3}>
              {describeRule(rule, names)}
            </Text>
          </VStack>
        </PressableScale>
        <Switch
          value={rule.enabled}
          disabled={busy !== null}
          onValueChange={(on) => void run(rule.id, () => setRuleEnabled(rule, on))}
          accessibilityLabel={`${rule.name} on`}
          testID={`rule-enabled-${rule.id}`}
        />
      </HStack>
    </View>
  );

  return (
    <Screen
      title="Rules"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="refresh-cw"
            accessibilityLabel="Reload rules"
            onPress={() => void rulesStore.load()}
            testID="rules-reload"
          />
          <BackAction fallback="/settings" />
        </HStack>
      }
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
          onRefresh={() => {
            setPulling(true);
            void rulesStore.load().finally(() => setPulling(false));
          }}
        />
      }
      testID="screen-rules"
    >
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="rules-error">
            {error}
          </Text>
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="rules-problem">
            {problem}
          </Text>
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="accent" icon="check">
          <Text variant="caption" testID="rules-notice">
            {notice}
          </Text>
        </Banner>
      ) : null}
      <VStack gap="sm">
        <Text variant="caption" tone="muted">
          Rules change transactions as they arrive from a sync or an import. Saving a rule also
          applies every rule that is on to the transactions already stored. A rule never changes
          something you edited by hand, and turning a rule off or deleting it does not undo what it
          changed.
        </Text>
        <HStack gap="sm" wrap>
          <Button
            label="Add a rule"
            icon="plus"
            variant="secondary"
            onPress={() => router.push({ pathname: '/rules/[id]', params: { id: 'new' } })}
            testID="rule-add"
          />
          <Button
            label="Apply rules to stored transactions"
            variant="secondary"
            disabled={busy !== null || !rules || rules.every((r) => !r.enabled)}
            loading={busy === 'run'}
            onPress={() => void run('run', applyRulesNow)}
            testID="rules-run"
          />
        </HStack>
      </VStack>
      {rules === null ? (
        loading ? (
          <Text variant="caption" tone="muted" testID="rules-loading">
            Loading...
          </Text>
        ) : null
      ) : rules.length === 0 ? (
        <Card>
          <EmptyState
            icon="funnel"
            title="No rules yet"
            message='A rule could say: if the name contains "uber", set the category to Transport.'
          />
        </Card>
      ) : (
        <Card padding="none">{rules.map(row)}</Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  body: { flex: 1 },
}));
