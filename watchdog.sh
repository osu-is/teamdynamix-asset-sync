#!/bin/bash

# This script is ran by a cronjob at 6:55 AM everyday.
# It checks to see if the sync script is running and
# kills it if it is in case it hung.

#Get all processes with the lockfile held
PID=$(/usr/sbin/lsof /data/is-tools/td-asset-sync/sync-lockfile | tr -s ' ' | cut -f2 -d' ' | tail -n2)

#If the lockfile is held, kill the processes holding it
if [ "$PID" ] ; then
	kill -15 $PID
	rm sync-lockfile
fi
