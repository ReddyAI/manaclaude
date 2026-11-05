import { Badge } from '../../design/components/Controls';
import { confidenceLabel, LOW_CONFIDENCE, type ReviewItem } from './reviewQueue';

/** The AI's confidence in a transaction's category. Amber below 60%, red when there is no category. */
export function ConfidencePill({
  item,
}: {
  item: Pick<ReviewItem, 'txn' | 'confidence' | 'transfer'>;
}) {
  const noCategory = !item.transfer && !item.txn.categoryId;
  const low = item.confidence < LOW_CONFIDENCE;
  return (
    <Badge
      label={confidenceLabel(item)}
      tone={noCategory ? 'danger' : low ? 'pending' : 'neutral'}
      icon={
        item.transfer ? 'link' : item.txn.aiCategoryConfidence !== null ? 'sparkles' : undefined
      }
    />
  );
}
