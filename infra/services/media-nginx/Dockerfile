# Nginx HLS origin with nginx.conf baked in (Coolify can't bind-mount the single
# repo file at runtime). The HLS segments still come from the shared hlsdata
# volume at runtime.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
