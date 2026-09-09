# Shared proxy headers. Kept in one file so an upstream can never be added with
# a different set - X-Forwarded-Proto in particular, without which the app
# cannot tell it is behind TLS.
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        "";
