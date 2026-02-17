FROM nginx:alpine

# カスタムnginx設定
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Dashboard ファイルをコピー
COPY index.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY manifest.json /usr/share/nginx/html/
COPY sw.js /usr/share/nginx/html/

# サブディレクトリ
COPY status/ /usr/share/nginx/html/status/
COPY diff/ /usr/share/nginx/html/diff/

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
