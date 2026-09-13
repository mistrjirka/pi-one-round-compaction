import importlib.util, json, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location("checkpoint",Path(__file__).with_name("validate-checkpoint.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Validation(unittest.TestCase):
 def state(self):return {"goal":"Finish the accepted cleanup", "priorities":["Preserve behavior"], "constraints":[], "work":[{"item":"Earlier optional change cancelled by user", "status":"cancelled", "source_ids":[2]}], "next_actions":[], "unknowns":[]}
 def test_complete_json_and_single_fence(self):
  text=json.dumps(self.state());self.assertEqual(module.validate(text,3),self.state());self.assertEqual(module.validate("```json\n"+text+"\n```",3),self.state())
 def test_duplicate_key_cannot_erase_work(self):
  text=json.dumps(self.state()).replace('"status": "cancelled"','"item": "", "status": "cancelled"')
  with self.assertRaises(ValueError):module.validate(text,3)
 def test_future_source_rejected(self):
  state=self.state();state["work"][0]["source_ids"]=[3]
  with self.assertRaises(AssertionError):module.validate(json.dumps(state),3)
 def test_unrecognized_status_or_empty_item_rejected(self):
  for field,value in [("status","COMPLETE"),("item","")]:
   state=self.state();state["work"][0][field]=value
   with self.assertRaises(AssertionError):module.validate(json.dumps(state),3)
 def test_extra_prose_is_not_silently_repaired(self):
  with self.assertRaises(ValueError):module.validate("Here is the answer: "+json.dumps(self.state()),3)
if __name__=="__main__":unittest.main()
