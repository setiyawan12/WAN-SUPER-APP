FROM alpine:3.22
RUN apk add --no-cache openssh-server shadow \
  && adduser -D -s /bin/sh wan \
  && passwd -d wan \
  && mkdir -p /run/sshd /home/wan/.ssh \
  && chown -R wan:wan /home/wan \
  && chmod 700 /home/wan/.ssh \
  && ssh-keygen -A
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]