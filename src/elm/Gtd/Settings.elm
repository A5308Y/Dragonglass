module Gtd.Settings exposing
    ( BoardConfiguration
    , DueRange(..)
    , Filter(..)
    , GroupBy(..)
    , MatchOperator(..)
    , ProjectColumnsBy(..)
    , ProjectSections(..)
    , SavedView
    , Settings
    , SortDirection(..)
    , SortField(..)
    , SortSpec
    , VisibleColumns(..)
    , decoder
    , defaultConfiguration
    , empty
    , encodeSavedView
    , findSavedView
    , groupByKey
    , groupByLabel
    , projectColumnsByKey
    , projectSectionsKey
    , reverse
    , sortFieldLabel
    , statusColumns
    )

{-| The UI-safe settings projection Elm receives with every snapshot.

Filesystem paths, calendar credentials, and other host-only settings never cross
the port boundary. Saved views are written through narrow commands rather than
by round-tripping this whole record.

Every enumerated choice a board can make — how it groups, how it sorts, and what
each filter asks — is a union here, so a board can only ever hold a combination
the settings file can represent.

-}

import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode



-- BOARD CONFIGURATION


type GroupBy
    = GroupByStatus
    | GroupByProject
    | GroupByContext
    | GroupByEnergy


type SortField
    = SortByManual
    | SortByCreated
    | SortByDue
    | SortByTitle
    | SortByProject


type SortDirection
    = Ascending
    | Descending


type alias SortSpec =
    { field : SortField, direction : SortDirection }


type MatchOperator
    = Is
    | IsNot


{-| What a due-date filter asks. Operator and operand travel together, so a
"within next days" filter can never carry a date and a "before" filter can never
carry a day count.
-}
type DueRange
    = DueBefore String
    | DueOnOrBefore String
    | DueAfter String
    | DueOnOrAfter String
    | DueWithinDays Int
    | DueIsEmpty
    | DueIsNotEmpty


{-| One board filter. Each field carries only the values that field can hold —
`Nothing` in a Project filter is the "No project" bucket.
-}
type Filter
    = ByStatus MatchOperator (List ActionStatus)
    | ByProject MatchOperator (List (Maybe ProjectId))
    | ByContext MatchOperator (List String)
    | ByEnergy MatchOperator (List String)
    | ByArea MatchOperator (List String)
    | ByDue DueRange


{-| Which group columns a board shows.

The keys stay strings because what a column means follows `groupBy`: a status
key while grouping by status, and a Project id, context, or energy otherwise.

-}
type VisibleColumns
    = AllColumns
    | OnlyColumns (List String)


{-| How a board lays out its Actions: `groupBy` picks what the columns are, and
`sections`, when set, splits each column by another field.
-}
type alias BoardConfiguration =
    { filters : List Filter
    , groupBy : GroupBy
    , sections : Maybe GroupBy
    , sort : SortSpec
    , visibleColumns : VisibleColumns
    }


{-| What the Projects board's columns are.
-}
type ProjectColumnsBy
    = ColumnsByStatus
    | ColumnsByArea


{-| What splits each Projects board column, if anything.
-}
type ProjectSections
    = NoSections
    | SectionsByArea
    | SectionsByStatus


type alias SavedView =
    { id : String
    , name : String
    , configuration : BoardConfiguration
    }



-- SETTINGS


type alias Settings =
    { showProjectBoardImages : Bool
    , projectBoardColumnsBy : ProjectColumnsBy
    , projectBoardSections : ProjectSections
    , defaultActionStatus : ActionStatus
    , showDoneColumn : Bool
    , projectBoardColumns : List ProjectStatus
    , savedViews : List SavedView
    , activeSavedViewId : Maybe String
    , defaultDurationMinutes : Int
    }


empty : Settings
empty =
    { showProjectBoardImages = True
    , projectBoardColumnsBy = ColumnsByStatus
    , projectBoardSections = NoSections
    , defaultActionStatus = ActionStatus.Next
    , showDoneColumn = True
    , projectBoardColumns = ProjectStatus.board
    , savedViews = []
    , activeSavedViewId = Nothing
    , defaultDurationMinutes = 30
    }



-- HELPERS


defaultConfiguration : Settings -> BoardConfiguration
defaultConfiguration settings =
    { filters = []
    , groupBy = GroupByStatus
    , sections = Nothing
    , sort = { field = SortByCreated, direction = Descending }
    , visibleColumns = OnlyColumns (List.map ActionStatus.key (statusColumns settings))
    }


{-| The status columns a board lays out, honouring the Done column preference.
-}
statusColumns : Settings -> List ActionStatus
statusColumns settings =
    [ ActionStatus.Next, ActionStatus.Waiting, ActionStatus.Scheduled ]
        ++ (if settings.showDoneColumn then
                [ ActionStatus.Done ]

            else
                []
           )


findSavedView : List SavedView -> String -> Maybe SavedView
findSavedView views savedId =
    List.filter (\saved -> saved.id == savedId) views |> List.head


reverse : SortDirection -> SortDirection
reverse direction =
    case direction of
        Ascending ->
            Descending

        Descending ->
            Ascending


groupByLabel : GroupBy -> String
groupByLabel groupBy =
    case groupBy of
        GroupByStatus ->
            "Status"

        GroupByProject ->
            "Project"

        GroupByContext ->
            "Context"

        GroupByEnergy ->
            "Energy"


sortFieldLabel : SortField -> String
sortFieldLabel field =
    case field of
        SortByManual ->
            "Manual"

        SortByCreated ->
            "Created"

        SortByDue ->
            "Due"

        SortByTitle ->
            "Title"

        SortByProject ->
            "Project"



-- DECODING


decoder : Decoder Settings
decoder =
    Decode.succeed Settings
        |> required "showProjectBoardImages" Decode.bool
        |> required "projectBoardColumnsBy" (Decode.map projectColumnsByFromKey Decode.string)
        |> required "projectBoardSections" (Decode.map projectSectionsFromKey Decode.string)
        |> required "defaultActionStatus" ActionStatus.decoder
        |> required "showDoneColumn" Decode.bool
        |> required "projectBoardColumns" (knownList ProjectStatus.decoder)
        |> required "savedViews" (knownList savedViewDecoder)
        |> required "activeSavedViewId" (Decode.maybe Decode.string)
        |> required "defaultDurationMinutes" Decode.int


savedViewDecoder : Decoder SavedView
savedViewDecoder =
    Decode.map3 SavedView
        (Decode.field "id" Decode.string)
        (Decode.field "name" Decode.string)
        configurationDecoder


configurationDecoder : Decoder BoardConfiguration
configurationDecoder =
    Decode.map5 BoardConfiguration
        (Decode.field "filters" (knownList filterDecoder))
        (Decode.field "groupBy" groupByDecoder)
        (optionalField "sectionBy" (Decode.nullable groupByDecoder) Nothing)
        (Decode.field "sort" sortDecoder)
        (optionalField "visibleColumns" visibleColumnsDecoder AllColumns)


visibleColumnsDecoder : Decoder VisibleColumns
visibleColumnsDecoder =
    Decode.maybe (Decode.list Decode.string)
        |> Decode.map
            (\maybeColumns ->
                case maybeColumns of
                    Just columns ->
                        OnlyColumns columns

                    Nothing ->
                        AllColumns
            )


groupByDecoder : Decoder GroupBy
groupByDecoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case raw of
                    "project" ->
                        Decode.succeed GroupByProject

                    "context" ->
                        Decode.succeed GroupByContext

                    "energy" ->
                        Decode.succeed GroupByEnergy

                    _ ->
                        Decode.succeed GroupByStatus
            )


sortDecoder : Decoder SortSpec
sortDecoder =
    Decode.map2 SortSpec
        (Decode.field "field" sortFieldDecoder)
        (Decode.field "direction" sortDirectionDecoder)


sortFieldDecoder : Decoder SortField
sortFieldDecoder =
    Decode.string
        |> Decode.map
            (\raw ->
                case raw of
                    "due" ->
                        SortByDue

                    "title" ->
                        SortByTitle

                    "project" ->
                        SortByProject

                    "manual" ->
                        SortByManual

                    _ ->
                        SortByCreated
            )


sortDirectionDecoder : Decoder SortDirection
sortDirectionDecoder =
    Decode.string
        |> Decode.map
            (\raw ->
                if raw == "asc" then
                    Ascending

                else
                    Descending
            )


filterDecoder : Decoder Filter
filterDecoder =
    Decode.field "kind" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "value" ->
                        valueFilterDecoder

                    "due" ->
                        Decode.map ByDue dueRangeDecoder

                    _ ->
                        Decode.fail ("Unknown filter kind: " ++ kind)
            )


valueFilterDecoder : Decoder Filter
valueFilterDecoder =
    Decode.map3 (\field operator values -> ( field, operator, values ))
        (Decode.field "field" Decode.string)
        (Decode.field "operator" matchOperatorDecoder)
        (Decode.field "values" (Decode.list Decode.value))
        |> Decode.andThen
            (\( field, operator, values ) ->
                let
                    strings =
                        List.filterMap (decodeOne Decode.string) values
                in
                case field of
                    "status" ->
                        Decode.succeed (ByStatus operator (List.filterMap (decodeOne ActionStatus.decoder) values))

                    "project" ->
                        Decode.succeed
                            (ByProject operator
                                (List.map
                                    (\raw ->
                                        if String.isEmpty raw then
                                            Nothing

                                        else
                                            Just raw
                                    )
                                    strings
                                )
                            )

                    "context" ->
                        Decode.succeed (ByContext operator strings)

                    "energy" ->
                        Decode.succeed (ByEnergy operator strings)

                    "area" ->
                        Decode.succeed (ByArea operator strings)

                    _ ->
                        Decode.fail ("Unknown filter field: " ++ field)
            )


matchOperatorDecoder : Decoder MatchOperator
matchOperatorDecoder =
    Decode.string
        |> Decode.map
            (\raw ->
                if raw == "notIn" then
                    IsNot

                else
                    Is
            )


dueRangeDecoder : Decoder DueRange
dueRangeDecoder =
    Decode.map2 Tuple.pair
        (Decode.field "operator" Decode.string)
        (optionalField "value" Decode.value Encode.null)
        |> Decode.andThen
            (\( operator, raw ) ->
                let
                    date =
                        decodeOne Decode.string raw |> Maybe.withDefault ""

                    days =
                        decodeOne Decode.int raw |> Maybe.withDefault 7
                in
                case operator of
                    "before" ->
                        Decode.succeed (DueBefore date)

                    "onOrBefore" ->
                        Decode.succeed (DueOnOrBefore date)

                    "after" ->
                        Decode.succeed (DueAfter date)

                    "onOrAfter" ->
                        Decode.succeed (DueOnOrAfter date)

                    "withinNextDays" ->
                        Decode.succeed (DueWithinDays days)

                    "isEmpty" ->
                        Decode.succeed DueIsEmpty

                    "isNotEmpty" ->
                        Decode.succeed DueIsNotEmpty

                    _ ->
                        Decode.fail ("Unknown due operator: " ++ operator)
            )


{-| Keeps the entries a decoder understands and drops the rest, so one stale
saved filter cannot blank a whole board.
-}
knownList : Decoder a -> Decoder (List a)
knownList itemDecoder =
    Decode.list Decode.value |> Decode.map (List.filterMap (decodeOne itemDecoder))


decodeOne : Decoder a -> Decode.Value -> Maybe a
decodeOne itemDecoder raw =
    Decode.decodeValue itemDecoder raw |> Result.toMaybe


required : String -> Decoder a -> Decoder (a -> b) -> Decoder b
required name itemDecoder pipeline =
    Decode.map2 (<|) pipeline (Decode.field name itemDecoder)


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name itemDecoder fallback =
    Decode.oneOf [ Decode.field name itemDecoder, Decode.succeed fallback ]



-- ENCODING


encodeSavedView : SavedView -> Encode.Value
encodeSavedView saved =
    Encode.object
        ([ ( "id", Encode.string saved.id ), ( "name", Encode.string saved.name ) ]
            ++ encodeConfigurationFields saved.configuration
        )


encodeConfigurationFields : BoardConfiguration -> List ( String, Encode.Value )
encodeConfigurationFields configuration =
    [ ( "filters", Encode.list encodeFilter configuration.filters )
    , ( "groupBy", Encode.string (groupByKey configuration.groupBy) )
    , ( "sectionBy", Maybe.map (groupByKey >> Encode.string) configuration.sections |> Maybe.withDefault Encode.null )
    , ( "sort"
      , Encode.object
            [ ( "field", Encode.string (sortFieldKey configuration.sort.field) )
            , ( "direction", Encode.string (sortDirectionKey configuration.sort.direction) )
            ]
      )
    , ( "visibleColumns"
      , case configuration.visibleColumns of
            AllColumns ->
                Encode.null

            OnlyColumns columns ->
                Encode.list Encode.string columns
      )
    ]


projectColumnsByKey : ProjectColumnsBy -> String
projectColumnsByKey columnsBy =
    case columnsBy of
        ColumnsByStatus ->
            "status"

        ColumnsByArea ->
            "area"


projectColumnsByFromKey : String -> ProjectColumnsBy
projectColumnsByFromKey raw =
    if raw == "area" then
        ColumnsByArea

    else
        ColumnsByStatus


projectSectionsKey : ProjectSections -> String
projectSectionsKey sections =
    case sections of
        NoSections ->
            "none"

        SectionsByArea ->
            "area"

        SectionsByStatus ->
            "status"


projectSectionsFromKey : String -> ProjectSections
projectSectionsFromKey raw =
    case raw of
        "area" ->
            SectionsByArea

        "status" ->
            SectionsByStatus

        _ ->
            NoSections


groupByKey : GroupBy -> String
groupByKey groupBy =
    case groupBy of
        GroupByStatus ->
            "status"

        GroupByProject ->
            "project"

        GroupByContext ->
            "context"

        GroupByEnergy ->
            "energy"


sortFieldKey : SortField -> String
sortFieldKey field =
    case field of
        SortByManual ->
            "manual"

        SortByCreated ->
            "created"

        SortByDue ->
            "due"

        SortByTitle ->
            "title"

        SortByProject ->
            "project"


sortDirectionKey : SortDirection -> String
sortDirectionKey direction =
    case direction of
        Ascending ->
            "asc"

        Descending ->
            "desc"


encodeFilter : Filter -> Encode.Value
encodeFilter filter =
    case filter of
        ByStatus operator values ->
            valueFilter "status" operator (List.map ActionStatus.key values)

        ByProject operator values ->
            valueFilter "project" operator (List.map (Maybe.withDefault "") values)

        ByContext operator values ->
            valueFilter "context" operator values

        ByEnergy operator values ->
            valueFilter "energy" operator values

        ByArea operator values ->
            valueFilter "area" operator values

        ByDue range ->
            let
                ( operator, value ) =
                    dueRangeFields range
            in
            Encode.object
                ([ ( "kind", Encode.string "due" ), ( "operator", Encode.string operator ) ]
                    ++ (case value of
                            Just encoded ->
                                [ ( "value", encoded ) ]

                            Nothing ->
                                []
                       )
                )


valueFilter : String -> MatchOperator -> List String -> Encode.Value
valueFilter field operator values =
    Encode.object
        [ ( "kind", Encode.string "value" )
        , ( "field", Encode.string field )
        , ( "operator"
          , Encode.string
                (case operator of
                    Is ->
                        "in"

                    IsNot ->
                        "notIn"
                )
          )
        , ( "values", Encode.list Encode.string values )
        ]


dueRangeFields : DueRange -> ( String, Maybe Encode.Value )
dueRangeFields range =
    case range of
        DueBefore date ->
            ( "before", Just (Encode.string date) )

        DueOnOrBefore date ->
            ( "onOrBefore", Just (Encode.string date) )

        DueAfter date ->
            ( "after", Just (Encode.string date) )

        DueOnOrAfter date ->
            ( "onOrAfter", Just (Encode.string date) )

        DueWithinDays days ->
            ( "withinNextDays", Just (Encode.int days) )

        DueIsEmpty ->
            ( "isEmpty", Nothing )

        DueIsNotEmpty ->
            ( "isNotEmpty", Nothing )
