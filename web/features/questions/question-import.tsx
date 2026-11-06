import { useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { ErrorNotice, PageHeader, useApp } from '../../shared/ui/components';
import { exportPackage } from '../../shared/lib/data-package';
import { DataPackageEditor } from '../../shared/ui/data-package-editor';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import './question-import.css';

export function QuestionImportPage() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [preparedFile, setPreparedFile] = useState<File | null>(null);
  const { toast } = useApp();
  const template = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await exportPackage({ kind: 'question-template' });
      toast('新增题目模板包已下载');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <a className="back-link" href="#/questions">
        <ArrowLeft size={15} />
        返回知识题库
      </a>
      <PageHeader
        eyebrow="BULK QUESTION IMPORT"
        title="批量收集，逐步核对。"
        description="把整理好的新题按模板导入。每道新题都进入待审核，通过审核后再加入正式题库。"
        actions={
          <a className="button" href="#/ai?tab=import">
            AI辅助转换 PDF / 文本
          </a>
        }
      />
      <div className="import-purpose-grid">
        <section className="card">
          <strong>新增与查重</strong>
          <p>
            完全重复复用原题，近似题可查看差异并选择处理方式。新增题仍需审核，覆盖已有题必须明确确认。
          </p>
        </section>
        <a className="card" href="#/questions/review">
          <strong>修改待审核题 →</strong>
          <p>在审核页导出、修改再回导，保留题号和版本；用于批量修正已有待审核内容。</p>
        </a>
        <a className="card" href="#/data">
          <strong>备份与题库迁移 →</strong>
          <p>迁移可信备份，保留发布和审核状态、题集、学习记录及作答历史。</p>
        </a>
      </div>
      <div className="ui-stack">
        <section className="card form-stack">
          <h2>1. 下载模板并整理题目</h2>
          <div className="action-row">
            <button className="button primary" disabled={busy} onClick={() => void template()}>
              <Download size={16} />
              下载新增题目模板包（ZIP）
            </button>
            <a className="button" href="#/taxonomy">
              管理分类与标签
            </a>
          </div>
          {error && <ErrorNotice message={error} />}
          <p className="muted">
            模板包含判断、单选、多选、填空、简答、论述及组合题示例，题目数据与参考文件由manifest组织。可在下方预览后编辑包内题目并重新生成校验清单，示例本身也会被当作新题导入。
          </p>
          <details className="import-field-help">
            <summary>查看字段与格式说明</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>填写方式</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>manifest.json</td>
                    <td>
                      包内根清单描述用途、文件路径、大小与校验摘要；导入时完整核对，不能仅上传题目JSON。
                    </td>
                  </tr>
                  <tr>
                    <td>数据分片 / questions</td>
                    <td>
                      保留分片外层格式。questions为题目数组，整包最多50000题（独立接口单批最多500题）；修改后须重新生成数据包及清单。
                    </td>
                  </tr>
                  <tr>
                    <td>id</td>
                    <td>
                      可省略，由系统生成。完全重复会复用原题；同号内容不同会列入差异核对，可覆盖原题、保留原题或另存。
                    </td>
                  </tr>
                  <tr>
                    <td>type</td>
                    <td>
                      true_false（判断）、single_choice（单选）、multiple_choice（多选）、fill_blank（填空）、short_answer（简答）、essay（论述/写作）；group表示带公共材料的组合题结构。
                    </td>
                  </tr>
                  <tr>
                    <td>title / stemMarkdown</td>
                    <td>题目名称与题干；题干可用 Markdown 编写代码、表格等。</td>
                  </tr>
                  <tr>
                    <td>answerMarkdown / explanationMarkdown</td>
                    <td>参考答案与解释、追问、误区。</td>
                  </tr>
                  <tr>
                    <td>options / correctAnswers</td>
                    <td>
                      客观题参照模板填写；判断答案为 ["true"] 或 ["false"]；选择题使用选项 key。
                    </td>
                  </tr>
                  <tr>
                    <td>blanks / parts</td>
                    <td>
                      填空的 blanks 按顺序填写提示、可接受答案和匹配规则；组合题 parts
                      填写独立小题及分值权重，不嵌套组合题。
                    </td>
                  </tr>
                  <tr>
                    <td>categoryIds / tagIds</td>
                    <td>填写系统中已有 ID，可先留 []。领域主题标签必须匹配题目分类的领域。</td>
                  </tr>
                  <tr>
                    <td>difficulty / depth / frequency</td>
                    <td>难度 D1—D4、深度 L1—L4、常见度 F0—F3；0表示未标常见度。</td>
                  </tr>
                  <tr>
                    <td>collection / status</td>
                    <td>
                      collection 为 general（通用内容）或 personal（个人专项）。批量新增的 status
                      一律变为 pending。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </section>
        <DataPackageEditor kind="question-template" onPrepared={setPreparedFile} />
        <DataPackageImport
          preparedFile={preparedFile}
          title="2. 导入新增题目数据包"
          description="上传包含manifest与题目数据的完整ZIP。系统自动识别新增、分享或迁移用途；新增题目全部进入待审核。"
        />
      </div>
    </>
  );
}
