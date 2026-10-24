FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html

# Simple config: serve static files, return index.html for unknown paths
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
        add_header Cache-Control "no-cache";\n\
    }\n\
    location /img/optimized/ {\n\
        try_files $uri =404;\n\
        add_header Cache-Control "public, max-age=2592000, immutable";\n\
    }\n\
    location /img/ {\n\
        try_files $uri =404;\n\
        add_header Cache-Control "public, max-age=86400";\n\
    }\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript text/html;\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
