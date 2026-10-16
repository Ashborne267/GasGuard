import os
import subprocess
from flask import request

def run_user_code():
    cmd = request.args.get('cmd')
    # Unsanitized os.system
    os.system(cmd)

    # Shell=True in subprocess
    subprocess.Popen(['echo', cmd], shell=True)
