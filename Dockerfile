FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html

# Simple config: serve static files, return index.html for unknown paths
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript text/html;\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
