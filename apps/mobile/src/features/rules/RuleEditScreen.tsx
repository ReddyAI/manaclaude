import type { Rule } from '@manaclaude/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { SegmentedControl, Switch, TextField } from '../../design/components/Controls';
import { Banner, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { BackAction } from '../planning/BackAction';
import { ActionEditor } from './ActionEditor';
import { ConditionEditor } from './ConditionEditor';
import { removeRule, rulesStore, saveRule } from './actions';
import {
  MAX_ACTIONS,
  MAX_CONDITIONS,
  RULE_NAME_MAX,
  checkDraft,
  draftFromRule,
  emptyDraft,
  newAction,
  newCondition,
  type ActionType,
  type RuleDraft,
} from './rules';

function leave(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/rules');
}

/** The first action type this rule does not have yet (add_tag can repeat). */
function nextActionType(draft: RuleDraft): ActionType {
  const order: ActionType[] = ['set_category', 'set_kind', 'set_name', 'mark_reviewed', 'exclude'];
  return order.find((t) => !draft.actions.some((a) => a.type === t)) ?? 'add_tag';
}

/**
 * Adds or changes one rule (POST /v1/rules, PUT /v1/rules/:id) and deletes it
 * (DELETE). Route: /rules/new or /rules/<id>.
 */
export function RuleEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  useBackendStatus();
  const { value: rules, loading, error } = rulesStore.use();
  const rule: Rule | null = isNew ? null : (rules?.find((r) => r.id === id) ?? null);

  const [draft, setDraft] = useState<RuleDraft | null>(isNew ? emptyDraft() : null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Set at once on a tap, so a fast second tap cannot save or delete twice.
  const sending = useRef(false);
  // A form filled in for another backend holds its ids: start again when the backend changes.
  const [draftScope, setDraftScope] = useState(config.scope);
  if (draftScope !== config.scope) {
    setDraftScope(config.scope);
    setDraft(isNew ? emptyDraft() : null);
    setTried(false);
    setConfirming(false);
    setProblem(null);
  } else if (!isNew && rule && draft === null) setDraft(draftFromRule(rule));

  useEffect(() => {
    if (ready && !isNew && rulesStore.get().value === null) void rulesStore.load();
  }, [ready, isNew, config.scope]);

  const title = isNew ? 'New rule' : 'Rule';
  const back = <BackAction fallback="/rules" />;

  if (!ready) {
    return (
      <Screen title={title} actions={back} testID="screen-rule">
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
  if (!isNew && !rule) {
    return (
      <Screen title={title} actions={back} testID="screen-rule">
        {rules === null ? (
          error ? (
            <Banner tone="danger" icon="triangle-alert">
              <Text variant="caption" testID="rule-load-error">
                {error}
              </Text>
            </Banner>
          ) : (
            <Text variant="caption" tone="muted">
              {loading ? 'Loading...' : ''}
            </Text>
          )
        ) : (
          <Card>
            <EmptyState
              icon="funnel"
              title="Rule not found"
              message="Your Worker does not have this rule. It may have been deleted."
            />
          </Card>
        )}
      </Screen>
    );
  }
  if (!draft) return null;

  // Account, category and tag ids must be this backend's, not the sample data's.
  const live = canSaveToBackend();
  const check = checkDraft(draft);
  const change = (patch: Partial<RuleDraft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setTried(true);
    setProblem(null);
    if (!check.input || !live || sending.current) return;
    sending.current = true;
    setBusy('save');
    try {
      await saveRule(isNew ? null : rule!.id, check.input);
      leave();
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!rule || sending.current) return;
    sending.current = true;
    setBusy('delete');
    setProblem(null);
    try {
      await removeRule(rule);
      leave();
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
    } finally {
      sending.current = false;
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <Screen title={title} actions={back} testID="screen-rule">
      {!live ? (
        <Banner tone="pending" icon="info">
          <Text variant="caption" testID="rule-not-loaded">
            Your data from this backend has not loaded yet, so its accounts, categories and tags
            cannot be picked and the rule cannot be saved. Pull down on Home to load it.
          </Text>
        </Banner>
      ) : null}
      {rule?.source === 'learned' ? (
        <Text variant="caption" tone="muted">
          The Worker made this rule from a category you corrected by hand. The next time you correct
          the category of a transaction from the same merchant, the Worker writes this rule again
          and your changes here are replaced.
        </Text>
      ) : null}
      <Card>
        <VStack gap="md">
          <TextField
            label="Name"
            value={draft.name}
            onChangeText={(name) => change({ name })}
            maxLength={RULE_NAME_MAX + 20}
            error={tried && check.name ? check.name : undefined}
            testID="rule-name"
          />
          <HStack gap="md" align="center" justify="space-between">
            <Text variant="bodyStrong">On</Text>
            <Switch
              value={draft.enabled}
              onValueChange={(enabled) => change({ enabled })}
              accessibilityLabel="Rule on"
              testID="rule-on"
            />
          </HStack>
          <VStack gap="xs">
            <TextField
              label="Priority"
              value={draft.priority}
              onChangeText={(priority) => change({ priority })}
              keyboardType="numbers-and-punctuation"
              error={tried && check.priority ? check.priority : undefined}
              testID="rule-priority"
            />
            <Text variant="caption" tone="muted">
              Lower numbers run first. When two rules set the same thing, the lower number wins.
            </Text>
          </VStack>
        </VStack>
      </Card>

      <SectionHeader title="When" />
      <Card>
        <VStack gap="md">
          <SegmentedControl
            options={[
              { value: 'all', label: 'Every condition' },
              { value: 'any', label: 'Any condition' },
            ]}
            value={draft.match}
            onChange={(match) => change({ match })}
            accessibilityLabel="Which conditions must match"
          />
          {draft.conditions.map((c, i) => (
            <ConditionEditor
              key={c.key}
              draft={c}
              index={i}
              problem={tried ? (check.conditions[c.key] ?? null) : null}
              onChange={(next) =>
                change({ conditions: draft.conditions.map((x) => (x.key === c.key ? next : x)) })
              }
              onRemove={() =>
                change({ conditions: draft.conditions.filter((x) => x.key !== c.key) })
              }
            />
          ))}
          <Button
            label="Add a condition"
            icon="plus"
            variant="ghost"
            disabled={draft.conditions.length >= MAX_CONDITIONS}
            onPress={() => change({ conditions: [...draft.conditions, newCondition('name')] })}
            testID="rule-add-condition"
          />
        </VStack>
      </Card>

      <SectionHeader title="Then" />
      <Card>
        <VStack gap="md">
          {draft.actions.map((a, i) => (
            <ActionEditor
              key={a.key}
              draft={a}
              index={i}
              taken={draft.actions.filter((x) => x.key !== a.key).map((x) => x.type)}
              problem={tried ? (check.actions[a.key] ?? null) : null}
              onChange={(next) =>
                change({ actions: draft.actions.map((x) => (x.key === a.key ? next : x)) })
              }
              onRemove={() => change({ actions: draft.actions.filter((x) => x.key !== a.key) })}
            />
          ))}
          <Button
            label="Add an action"
            icon="plus"
            variant="ghost"
            disabled={draft.actions.length >= MAX_ACTIONS}
            onPress={() =>
              change({ actions: [...draft.actions, newAction(nextActionType(draft))] })
            }
            testID="rule-add-action"
          />
        </VStack>
      </Card>

      {tried && check.general.length > 0 ? (
        <Text variant="caption" tone="danger" testID="rule-general-problem">
          {check.general.join(' ')}
        </Text>
      ) : null}
      {tried && !check.input && check.general.length === 0 ? (
        <Text variant="caption" tone="danger" testID="rule-form-problem">
          Some fields above need a change before the rule can be saved.
        </Text>
      ) : null}
      {problem ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="rule-problem">
            {problem}
          </Text>
        </Banner>
      ) : null}
      <Text variant="caption" tone="muted">
        Saving also applies every rule that is on to the transactions already stored. The rules list
        then says how many changed.
      </Text>
      <Button
        label={isNew ? 'Save the rule' : 'Save changes'}
        disabled={!live || busy !== null}
        loading={busy === 'save'}
        onPress={() => void save()}
        testID="rule-save"
      />
      {rule ? (
        confirming ? (
          <Card tone="sunken">
            <VStack gap="sm">
              <Text variant="body">Delete this rule? What it already changed stays as it is.</Text>
              <HStack gap="sm">
                <Button
                  label="Delete"
                  variant="danger"
                  loading={busy === 'delete'}
                  disabled={busy === 'save'}
                  onPress={() => void remove()}
                  testID="rule-delete-confirm"
                />
                <Button
                  label="Keep it"
                  variant="ghost"
                  onPress={() => setConfirming(false)}
                  testID="rule-delete-cancel"
                />
              </HStack>
            </VStack>
          </Card>
        ) : (
          <Button
            label="Delete this rule"
            variant="danger"
            disabled={busy !== null}
            onPress={() => setConfirming(true)}
            testID="rule-delete"
          />
        )
      ) : null}
    </Screen>
  );
}
