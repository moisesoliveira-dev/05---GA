# Revelação de cartas

A mesma tela do HTML, com as fotos gravadas na aplicação (`data/uploads` e `data/state.json`). Atualizar a página não apaga as cartas.

## No seu computador

```bash
npm install
npm start
```

Abra http://localhost:3000

Com Docker:

```bash
docker compose up --build
```

As imagens ficam na pasta `data/`.

## No Railway

1. Crie um serviço a partir deste diretório (Railway CLI: `railway up`) ou de um repositório Git. O `Dockerfile` já é detectado.
2. Em **Variables**, se quiser travar inclusão, embaralhamento, reset e remoção:

   `ADMIN_PASSWORD` = uma senha sua

   Quem só vai revelar cartas não precisa da senha. Quem edita digita a senha no campo do topo; ela fica só naquele navegador.
3. Em **Volumes**, crie um volume e monte em `/data`.

   Sem esse volume o Railway apaga os arquivos a cada deploy novo. Com o volume, as fotos continuam na aplicação.

`PORT` o Railway define sozinho. `DATA_DIR` já vale `/data` dentro da imagem.

Formatos: JPEG, PNG, WEBP e GIF, até 10 MB cada, no máximo 200 cartas.
