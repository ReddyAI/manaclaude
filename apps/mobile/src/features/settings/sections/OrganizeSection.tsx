import { IconBadge } from '../../../design/components/Decor';
import { ListRow } from '../../../design/components/ListRow';
import { isBackendReady, useBackendConfig } from '../../../data/backend/config';
import { goTo } from '../../planning/navigate';
import { SettingsGroup } from '../SettingsRow';

/**
 * The way to the categories and rules screens. Both are kept by the Worker,
 * so the rows say so when no backend is set.
 */
export function OrganizeSection() {
  const ready = isBackendReady(useBackendConfig());
  const needs = ready ? undefined : 'Needs the backend (Settings, Backend)';
  return (
    <SettingsGroup title="Categories and rules">
      <ListRow
        title="Categories"
        subtitle={needs ?? 'Add, rename, archive, reorder, leave out of budgets'}
        leading={<IconBadge icon="tag" color="c3" />}
        onPress={() => goTo('/categories')}
        showChevron
        testID="settings-categories"
      />
      <ListRow
        title="Rules"
        subtitle={needs ?? 'Set the category, name or kind of matching transactions'}
        leading={<IconBadge icon="funnel" color="c6" />}
        onPress={() => goTo('/rules')}
        showChevron
        testID="settings-rules"
      />
    </SettingsGroup>
  );
}
