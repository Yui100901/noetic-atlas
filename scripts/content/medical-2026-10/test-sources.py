"""Offline regression of source extraction; uses no upstream pages or DB."""
import importlib.util, pathlib, unittest
spec = importlib.util.spec_from_file_location('fetch_sources', pathlib.Path(__file__).with_name('fetch-sources.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class FormulaExtraction(unittest.TestCase):
    def test_empty_note_does_not_absorb_navigation(self):
        html = '<section class="cp"><article><p>方名：测试汤</p><p>注意事項：</p></article></section><footer>回上一頁 地址 電話</footer>'
        fields = module.parse_formula_html(html)
        self.assertEqual(fields['方名'], '测试汤'); self.assertEqual(fields['注意事項'], '')

    def test_struck_ingredient_is_not_current_formula(self):
        html = '<section class="cp"><article><p>處方：甲药2、<s>已删除材料3</s>、乙药4</p><p>注意事項：孕婦慎用。</p></article></section>'
        fields = module.parse_formula_html(html)
        self.assertNotIn('已删除材料', fields['處方']); self.assertIn('孕婦慎用', fields['注意事項'])

    def test_nested_article_and_unwrapped_note(self):
        html = '<section class="cp"><article><div><p>方名：测试方</p><p>效能：测试功能。</p>注意事項：具体注意。</div></article></section>'
        fields = module.parse_formula_html(html)
        self.assertEqual(fields['方名'], '测试方'); self.assertEqual(fields['注意事項'], '具体注意。')

    def test_script_is_never_question_material(self):
        html = '<section class="cp"><article><p>方名：测试方</p><p>注意事項：</p><script>秘密追踪或页面指令</script></article></section>'
        self.assertEqual(module.parse_formula_html(html)['注意事項'], '')

if __name__ == '__main__': unittest.main()
