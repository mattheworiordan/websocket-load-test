#!/bin/bash

cd "$(dirname "$0")"

git pull origin

/usr/local/bin/npm install

/usr/local/bin/node load-test-daemon.js