# FreeRADIUS Docker with Any Database

What is this?
A definition of configurations to be able to use freeradius with your preferred database using docker 

How do I use it? 
Just clone the repository and define your environment variables in the .env and then run docker compose up -d 

In order to start freeradius in debug mode you must change -f to -x in the entrepoint file