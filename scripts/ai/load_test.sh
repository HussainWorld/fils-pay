#!/usr/bin/env bash
# Stepped load test against our own Dilmune server (read-only endpoints).
H=http://139.59.57.131
OUT=$(dirname "$0")
echo "endpoint,concurrency,rps,mean_ms,p50_ms,p95_ms,p99_ms,failed,non2xx,complete" > $OUT/results.csv
for ep in "static:/dashboard/login" "health:/healthz" "db_read:/v1/payment-links/plink_loadtest_missing"; do
  name=${ep%%:*}; path=${ep#*:}
  for c in 10 50 100 200; do
    ab -q -k -t 15 -n 1000000 -c $c -s 10 "$H$path" > $OUT/ab-$name-$c.txt 2>&1
    rps=$(grep "Requests per second" $OUT/ab-$name-$c.txt | awk '{print $4}')
    mean=$(grep "Time per request" $OUT/ab-$name-$c.txt | head -1 | awk '{print $4}')
    p50=$(grep -E "^ +50%" $OUT/ab-$name-$c.txt | awk '{print $2}')
    p95=$(grep -E "^ +95%" $OUT/ab-$name-$c.txt | awk '{print $2}')
    p99=$(grep -E "^ +99%" $OUT/ab-$name-$c.txt | awk '{print $2}')
    fail=$(grep "Failed requests" $OUT/ab-$name-$c.txt | awk '{print $3}')
    non2xx=$(grep "Non-2xx" $OUT/ab-$name-$c.txt | awk '{print $3}'); non2xx=${non2xx:-0}
    comp=$(grep "Complete requests" $OUT/ab-$name-$c.txt | awk '{print $3}')
    echo "$name,$c,$rps,$mean,$p50,$p95,$p99,$fail,$non2xx,$comp" >> $OUT/results.csv
    sleep 3
  done
done
# recovery: health right after the heaviest step
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "recovery %{http_code} %{time_total}s\n" $H/healthz; sleep 1; done >> $OUT/recovery.txt
echo DONE >> $OUT/results.csv
