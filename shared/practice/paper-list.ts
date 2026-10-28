import type { Paper, PaperScoring } from '../models/types.js';
import type { Paged } from '../utils/pagination.js';

/** Card metadata only. Member IDs, snapshots and per-question score maps are
 * fetched through their dedicated detail or reading endpoints. */
export type PaperListItem = Pick<Paper, 'id' | 'title' | 'description' | 'mode' | 'questionCount' | 'practiceKind' | 'organization' | 'domainId' | 'archived' | 'version' | 'createdAt' | 'updatedAt'> & {
  scoring: Pick<PaperScoring, 'enabled' | 'scheme' | 'totalPoints' | 'objectivePoints' | 'subjectivePoints'>;
};
export type PaperListPage = Paged<PaperListItem>;
export type PaperMetadata = Pick<Paper, 'id' | 'title' | 'archived' | 'version'>;
