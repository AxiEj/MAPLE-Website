import importlib.util
import unittest


spec = importlib.util.spec_from_file_location(
    "plot_opt",
    "/home/axie/MAPLE/MAPLE-Website/assets/images/opt/tools/plot_opt.py",
)
plot_opt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plot_opt)


class MethodDetectionTests(unittest.TestCase):
    def test_detects_lbfgs_from_example_output_path(self):
        path = "/home/axie/MAPLE/MAPLE/example/opt/lbfgs/inp1.out"
        self.assertEqual(plot_opt._method_from_path(path), "lbfgs")


if __name__ == "__main__":
    unittest.main()
