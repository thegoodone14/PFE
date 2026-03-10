from django.urls import path
from .views import ItinerarySearch, PedestrianSearch

urlpatterns = [
    # Route transport en commun (Navitia + MongoDB)
    path('search/', ItinerarySearch.as_view(), name='search_itinerary'),
    
    # Route Piétonne (TomTom)
    path('pedestrian/', PedestrianSearch.as_view(), name='search_pedestrian'),
]