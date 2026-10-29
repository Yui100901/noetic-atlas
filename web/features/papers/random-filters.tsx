import type { PaperFilters, QuestionType } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import { CategoryOptions, Field, MultiSelect, useApp } from '../../shared/ui/components';
import { TagPicker } from '../../shared/ui/tag-picker';

// Controlled range selector shared by paper authoring and quick practice.
// The caller keeps normalization, domain/category resets and draft persistence.
export function RandomFilters({
  random,
  set,
}: {
  random: PaperFilters;
  set: <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => void;
}) {
  const { bootstrap } = useApp();
  return (
    <>
      <div className="form-grid">
        <Field label="知识领域">
          <select
            value={random.domainId || ''}
            onChange={(event) => set('domainId', event.target.value)}
          >
            <option value="">所有领域</option>
            {bootstrap.domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="分类（包括子类）">
          <select
            value={random.categoryId || ''}
            onChange={(event) => set('categoryId', event.target.value)}
          >
            <option value="">所有分类</option>
            <CategoryOptions
              categories={bootstrap.categories}
              domainId={random.domainId || undefined}
            />
          </select>
        </Field>
      </div>
      <TagPicker
        tags={bootstrap.tags}
        domains={bootstrap.domains}
        domainIds={random.domainId ? [random.domainId] : undefined}
        values={random.tagIds || []}
        onChange={(value) => set('tagIds', value)}
      />
      <Field label="标签匹配方式">
        <select
          value={random.tagMode}
          onChange={(event) => set('tagMode', event.target.value as 'all' | 'any')}
        >
          <option value="all">同时包含所有标签（AND）</option>
          <option value="any">包含任一标签（OR）</option>
        </select>
      </Field>
      <MultiSelect
        label="题型"
        options={Object.entries(typeLabels).map(([id, name]) => ({ id, name }))}
        values={random.types || []}
        onChange={(value) => set('types', value as QuestionType[])}
      />
      <div className="form-grid">
        <Field label="最低难度">
          <select
            value={random.difficultyMin}
            onChange={(event) => set('difficultyMin', Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                D{value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="最高难度">
          <select
            value={random.difficultyMax}
            onChange={(event) => set('difficultyMax', Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                D{value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="最低常见度">
          <select
            value={random.frequencyMin}
            onChange={(event) => set('frequencyMin', Number(event.target.value))}
          >
            <option value="0">不限制（含未标常见度）</option>
            <option value="1">F1 · 拓展及以上</option>
            <option value="2">F2 · 较少见及常见</option>
            <option value="3">F3 · 常见</option>
          </select>
        </Field>
        <Field label="内容属性">
          <select
            value={random.collection}
            onChange={(event) =>
              set('collection', event.target.value as PaperFilters['collection'])
            }
          >
            <option value="all">通用 + 个人专项</option>
            <option value="general">通用内容</option>
            <option value="personal">个人专项</option>
          </select>
        </Field>
      </div>
    </>
  );
}
