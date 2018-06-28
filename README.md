# TeamDynamix Asset Sync

## Overview
This repository contains a collection of scripts used for syncing assets from SCCM and Casper to TeamDynamix.

## Script Information
The script is ran automatically through a Cron job. To configure or view this file, type `crontab -e` on the production server. Currently, both SCCM and Casper sync every 10 minutes. SCCM will sync on every '5' of the hour, while Casper will sync on every '0' of the hour.

The log files for both Casper and SCCM syncs can be found in:
`/home/pm2/.pm2/logs/`

## Vendor and Manufacturer Files
TeamDynamix requires new vendor and manufacturer data to be uploaded manually via XLSX.
Unfortunately, it does not check for duplicate entries, so the export vendors script (./export-vendors.js) utilizes the TD API to generate a list of vendors and manufacturers which do not yet exist in TD.
This generates an XLSX file.

### Generating Vendor and Manufacturer Files
To generate the XLSX for upload, simply run the following command:
```
$NODE_ENV=production node export-vendors.js
```
