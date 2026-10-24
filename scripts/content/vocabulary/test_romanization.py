"""Focused phonetic conversion checks; no database is opened."""
import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('enrich',pathlib.Path(__file__).with_name('enrich-vocabulary.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RomanizationTest(unittest.TestCase):
    def test_hepburn_and_kana_boundaries(self):
        cases={'し':'shi','ち':'chi','つ':'tsu','ふ':'fu','しゃしん':'shashin','がっこう':'gakkou','まっちゃ':'matcha','しんよう':'shin\'you','しんい':'shin\'i','コンピューター':'konpyūtā','ウィーク':'wīku','ファイル':'fairu','ディスク':'disuku','きょう':'kyou','おもう':'omou'}
        for kana,expected in cases.items():
            with self.subTest(kana=kana):self.assertEqual(module.romanize(kana),expected)
    def test_unknown_readings_are_not_made_up(self):
        with self.assertRaises(ValueError):module.romanize('東京')

if __name__=='__main__':unittest.main()
