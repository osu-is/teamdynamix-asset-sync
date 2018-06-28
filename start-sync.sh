#!/bin/bash

# This script is ran by a cronjob every ten minutes from 7AM to 7PM
# and once more at 10PM every day to sync the TD assets with SCCM and
# Casper. It exits out if it tries to run while already running to
# prevent multiple updates from happening simultaneously.

# change the paths below to wherever files live.
exec 9>/data/is-tools/td-asset-sync/sync-lockfile
if ! flock -n 9 ; then
	echo "Another instance of $0 is running";
	exit 1
fi

# /home/pm2/.pm2/logs/* is where we keep our console output logs
date --rfc-3339=seconds >> /home/pm2/.pm2/logs/sccm-sync.log
NODE_ENV=production node /data/is-tools/td-asset-sync/sccm-sync.js >> /home/pm2/.pm2/logs/sccm-sync.log

date --rfc-3339=seconds >> /home/pm2/.pm2/logs/casper-sync.log
NODE_ENV=production node /data/is-tools/td-asset-sync/casper-sync.js >> /home/pm2/.pm2/logs/casper-sync.log

