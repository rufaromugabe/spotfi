#!/bin/bash
# Real-time authentication monitoring
ssh root@10.1.30.1 'logread -f | grep --line-buffered -E "(uspot|UAM|RADIUS|auth|challenge|logon|Access-|CHAP|10.1.30|5c:ba:ef)"'
