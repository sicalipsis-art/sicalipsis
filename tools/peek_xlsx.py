"""Print the shape, headers and first rows of every sheet in the given .xlsx files."""
import sys
from pathlib import Path
import openpyxl

for path in sys.argv[1:]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    print(f"\n=== {Path(path).name}")
    for ws in wb.worksheets:
        rows = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, "") for c in r)]
        if not rows:
            print(f"  [{ws.title}] empty")
            continue
        width = max(len(r) for r in rows)
        print(f"  [{ws.title}] {len(rows)} non-empty rows x {width} cols")
        for r in rows[:4]:
            print("    ", [("" if c is None else str(c)[:38]) for c in r])
