#!/bin/bash
# Test shell script for LumiChat upload

echo "Starting deployment..."
for service in nginx app worker; do
  echo "Restarting $service..."
  sleep 1
done
echo "Deployment complete!"
