export function ImportDedupToggle({
  enabled,
  onChange,
  disabled = false,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-stack">
      <label className="check-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        导入前查重
      </label>
      {!enabled && (
        <p className="notice warning" role="status">
          已关闭查重：不检查或合并重复、相似内容。仍校验格式、引用和附件，新增题仍需审核。
        </p>
      )}
    </div>
  );
}
