#!/bin/bash

cd "$(dirname "$0")"

git pull origin

npm install

node load-test-daemon.js