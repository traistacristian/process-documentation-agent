# PyInstaller entry point (the package uses relative imports, so it cannot be the entry script).
import sys
from pda_agent.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
