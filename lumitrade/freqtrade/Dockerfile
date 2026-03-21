FROM freqtradeorg/freqtrade:stable_freqai
RUN pip install --no-cache-dir setuptools datasieve && \
    pip install --no-cache-dir --no-deps smartmoneyconcepts

# Fix datasieve Pipeline missing features_in on unfit objects (sklearn 1.8+ compat).
# features_in is only set during fit; if a NaN-drop causes backtest to call transform
# on an unfitted pipeline the AttributeError cascades and kills the backtest.
# Patch: initialise features_in=None in __init__ and guard the column check.
RUN python - <<'EOF'
import sys
path = '/home/ftuser/.local/lib/python3.13/site-packages/datasieve/pipeline.py'
src = open(path).read()

old1 = (
    '        self.pandas_types: bool = False\n'
    '        self.feature_list: list = []\n'
    '        self.label_list: list = []\n'
    '        self.step_strings: list = []'
)
new1 = old1 + '\n        self.features_in = None  # initialized on first fit'
if 'self.features_in = None' not in src:
    src = src.replace(old1, new1, 1)
    assert 'self.features_in = None' in src, 'patch1 failed'

old2 = (
    '        elif isinstance(X, pd.DataFrame) and not fit:\n'
    '            if list(X.columns) != list(self.features_in):\n'
    '                raise Exception(f"Pipeline expected {self.features_in} but got {X.columns}.")'
)
new2 = (
    '        elif isinstance(X, pd.DataFrame) and not fit:\n'
    '            if self.features_in is not None and list(X.columns) != list(self.features_in):\n'
    '                raise Exception(f"Pipeline expected {self.features_in} but got {X.columns}.")'
)
if 'self.features_in is not None and' not in src:
    src = src.replace(old2, new2, 1)
    assert 'self.features_in is not None and' in src, 'patch2 failed'

open(path, 'w').write(src)
print('datasieve pipeline.py patched OK')
EOF
