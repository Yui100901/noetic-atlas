import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../../shared/ui/components';
import { AiPaperPlanner } from '../ai/ai-paper-plan';
import { AiWorkspaceDraftSession } from '../ai/ai-workspace-draft-context';
import { PaperCreationModes } from './paper-creation-modes';
import '../ai/ai.css';
import '../ai/ai-import-layout.css';

export function AiPaperCreatePage() {
  return (
    <AiWorkspaceDraftSession>
      <div className="paper-editor-page">
        <a className="back-link" href="#/papers">
          <ArrowLeft size={15} />
          返回题集
        </a>
        <PageHeader
          eyebrow="BUILD YOUR PRACTICE"
          title="按学习要求，推荐一份题集。"
          description="描述目标，由 AI 从已有题库推荐；核对题目、顺序和分值后再创建。"
        />
        <PaperCreationModes mode="ai" />
        <AiPaperPlanner />
      </div>
    </AiWorkspaceDraftSession>
  );
}
