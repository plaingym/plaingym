# SPDX-License-Identifier: AGPL-3.0-only
"""Sample the guest host and real container cgroups."""
import json
import pathlib
import subprocess
import time

COMPOSE = ["docker", "compose", "--project-directory", "/opt/plaingym", "--env-file",
           "/opt/plaingym/.env", "-f", "/opt/plaingym/compose.yaml"]
containers = {}
for service in ["caddy", "app", "postgres"]:
    cid = subprocess.check_output(COMPOSE + ["ps", "-q", service], text=True).strip()
    obj = json.loads(subprocess.check_output(["docker", "inspect", cid]))[0]
    pid = obj["State"]["Pid"]
    group = next(line.split(":", 2)[2] for line in pathlib.Path("/proc/%s/cgroup" % pid).read_text().splitlines() if line.startswith("0:"))
    containers[service] = (cid, pathlib.Path("/sys/fs/cgroup") / group.lstrip("/"), obj["RestartCount"])
while True:
    sample = {"at": time.time(), "containers": {}}
    for service, (cid, group, initial_restarts) in containers.items():
        def read(name):
            return group.joinpath(name).read_text().strip()
        sample["containers"][service] = {
            "current": int(read("memory.current")), "peak": int(read("memory.peak")),
            "max": read("memory.max"), "swap": int(read("memory.swap.current")),
            "events": dict((key, int(value)) for key, value in
                           (line.split() for line in read("memory.events").splitlines())),
            "initialRestarts": initial_restarts,
        }
    sample["host"] = dict((line.split(":")[0], int(line.split()[1]) * 1024)
                          for line in pathlib.Path("/proc/meminfo").read_text().splitlines()
                          if line.startswith(("MemTotal:", "MemAvailable:", "SwapTotal:", "SwapFree:")))
    sample["hostOomKills"] = int(next(line.split()[1] for line in pathlib.Path("/proc/vmstat").read_text().splitlines() if line.startswith("oom_kill ")))
    print(json.dumps(sample), flush=True)
    time.sleep(0.5)
