import { createScopedStore } from '../../data/backend/scopedStore';
import { getAiStatus } from './askApi';

/** The Worker's AI settings and today's use, in memory only, dropped when the backend changes. */
export const aiStatusStore = createScopedStore(getAiStatus);
