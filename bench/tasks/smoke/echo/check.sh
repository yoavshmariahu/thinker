#!/bin/bash
python3 -c "import mod; assert mod.beta()==2; print('CHECK OK')" 2>&1 | tail -1
