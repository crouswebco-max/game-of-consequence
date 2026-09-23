#!/bin/bash
# EC2 user data for A Game of Consequence (Amazon Linux 2023).
# Paste this whole file into "User data" when you launch the instance.
# It installs Node.js, downloads the game from GitHub and runs it on port 80,
# restarting it if it crashes or the instance reboots.

# ---- CHANGE THIS before launching: the password for the projector screen ----
HOST_PASSWORD="change-me-to-something-secret"

dnf install -y nodejs git
git clone https://github.com/crouswebco-max/game-of-consequence.git /opt/consequence
chown -R ec2-user:ec2-user /opt/consequence

# The instance's public IP, from the instance metadata service (IMDSv2),
# so the QR code on the projector points phones at the right address
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)

cat > /etc/systemd/system/consequence.service <<SERVICE
[Unit]
Description=A Game of Consequence
After=network-online.target

[Service]
User=ec2-user
WorkingDirectory=/opt/consequence
Environment=CONSEQUENCE_PUBLIC_URL=http://$PUBLIC_IP
Environment=CONSEQUENCE_HOST_PASSWORD=$HOST_PASSWORD
ExecStart=/usr/bin/node server.js 80
# Lets the game use port 80 without running as root
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now consequence
